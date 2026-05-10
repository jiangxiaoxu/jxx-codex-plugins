#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const binDir = join(runtimeDir, "bin");
const latestPath = join(runtimeDir, "latest.json");
const defaultRepo = "jiangxiaoxu/jxx-codex-plugins";

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${stderr}`);
  }
  return result.stdout ?? "";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

function releaseAssetUrl(repo, releaseTag, assetName) {
  if (!releaseTag) {
    return `https://github.com/${repo}/releases/latest/download/${encodePathSegment(assetName)}`;
  }
  return `https://github.com/${repo}/releases/download/${encodePathSegment(releaseTag)}/${encodePathSegment(assetName)}`;
}

function downloadFile(url, destination, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "jxx-codex-plugins-node-repl-bootstrap",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume();
          const redirectUrl = new URL(response.headers.location, url).toString();
          downloadFile(redirectUrl, destination, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed: HTTP ${statusCode} for ${url}`));
          return;
        }

        const file = createWriteStream(destination);
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}

function readLatest() {
  if (!isFile(latestPath)) {
    return {};
  }
  return JSON.parse(readFileSync(latestPath, "utf8"));
}

function hasOverrideRuntime() {
  return isFile(process.env.NODE_REPL_NODE_PATH) && isFile(process.env.CODEX_NODE_REPL_PATH);
}

function hasVendoredRuntime() {
  return isFile(join(binDir, "node.exe")) && isFile(join(binDir, "node_repl.exe"));
}

if (hasVendoredRuntime() && process.env.NODE_REPL_RUNTIME_REFRESH !== "1") {
  process.exit(0);
}

if (hasOverrideRuntime() && process.env.NODE_REPL_RUNTIME_REFRESH !== "1") {
  process.exit(0);
}

const latest = readLatest();
const repo = process.env.NODE_REPL_RUNTIME_REPO || latest.repo || defaultRepo;
const assetName = latest.assetName || "node-repl-runtime-win32-x64.tar.gz";
const manifestAssetName =
  latest.manifestAssetName || "node-repl-runtime-win32-x64.manifest.json";
const tmpDir = mkdtempSync(join(os.tmpdir(), "node-repl-runtime-"));

try {
  const assetPath = join(tmpDir, assetName);
  const manifestPath = join(tmpDir, manifestAssetName);
  await downloadFile(releaseAssetUrl(repo, latest.releaseTag, assetName), assetPath);
  await downloadFile(releaseAssetUrl(repo, latest.releaseTag, manifestAssetName), manifestPath);

  if (!isFile(assetPath)) {
    throw new Error(`Runtime asset not downloaded: ${assetName}`);
  }
  if (!isFile(manifestPath)) {
    throw new Error(`Runtime manifest not downloaded: ${manifestAssetName}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedSha = manifest.sha256 || latest.sha256;
  if (!expectedSha) {
    throw new Error("Runtime manifest does not include sha256.");
  }

  const actualSha = sha256(assetPath);
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`Runtime sha256 mismatch. Expected ${expectedSha}, got ${actualSha}.`);
  }

  run("tar", ["-xzf", assetPath, "-C", runtimeDir]);

  if (!hasVendoredRuntime()) {
    throw new Error("Runtime extraction completed but expected binaries are missing.");
  }

  writeFileSync(join(runtimeDir, manifestAssetName), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
