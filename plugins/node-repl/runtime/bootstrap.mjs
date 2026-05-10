#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const binDir = join(runtimeDir, "bin");
const latestPath = join(runtimeDir, "latest.json");
const lockDir = join(runtimeDir, ".runtime-update.lock");
const lockHeartbeatPath = join(lockDir, "heartbeat");
const defaultRepo = "jiangxiaoxu/jxx-codex-plugins";
const runtimeFiles = ["bin/node.exe", "bin/node_repl.exe"];

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
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

function isRunningVendoredNode() {
  return resolve(process.execPath).toLowerCase() === resolve(join(binDir, "node.exe")).toLowerCase();
}

function expectedRuntimeHash(latest, relativePath) {
  return latest?.files?.[relativePath]?.sha256 || "";
}

function runtimeMatchesLatest(latest) {
  if (!hasVendoredRuntime()) {
    return false;
  }

  return runtimeFiles.every((relativePath) => {
    const expectedHash = expectedRuntimeHash(latest, relativePath);
    if (!expectedHash) {
      return false;
    }

    const filePath = join(runtimeDir, relativePath);
    return isFile(filePath) && sha256(filePath).toLowerCase() === expectedHash.toLowerCase();
  });
}

function removeExtractedRuntime() {
  rmSync(binDir, { recursive: true, force: true });
}

function acquireLock() {
  try {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
    writeLockHeartbeat();
    return true;
  } catch {
    return false;
  }
}

function writeLockHeartbeat() {
  writeFileSync(lockHeartbeatPath, `${Date.now()}\n`);
}

function releaseLock() {
  rmSync(lockDir, { recursive: true, force: true });
}

function lockAgeMs() {
  try {
    const timestampPath = isFile(lockHeartbeatPath) ? lockHeartbeatPath : lockDir;
    return Date.now() - statSync(timestampPath).mtimeMs;
  } catch {
    return 0;
  }
}

async function waitForRuntimeUpdateLock(latest) {
  const timeoutMs = positiveIntegerEnv("NODE_REPL_RUNTIME_LOCK_TIMEOUT_MS", 120000);
  const staleMs = positiveIntegerEnv("NODE_REPL_RUNTIME_LOCK_STALE_MS", 600000);
  const startedAt = Date.now();

  while (existsSync(lockDir)) {
    if (runtimeMatchesLatest(latest)) {
      return;
    }
    if (lockAgeMs() > staleMs) {
      releaseLock();
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for runtime update lock: ${lockDir}`);
    }
    await sleep(500);
  }
}

async function installRuntime(latest) {
  const repo = process.env.NODE_REPL_RUNTIME_REPO || latest.repo || defaultRepo;
  const assetName = latest.assetName || "node-repl-runtime-win32-x64.tar.gz";
  const manifestAssetName =
    latest.manifestAssetName || "node-repl-runtime-win32-x64.manifest.json";
  const tmpDir = mkdtempSync(join(os.tmpdir(), "node-repl-runtime-"));
  const assetPath = join(tmpDir, assetName);
  const manifestPath = join(tmpDir, manifestAssetName);

  try {
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

    removeExtractedRuntime();
    run("tar", ["-xzf", assetPath, "-C", runtimeDir]);

    if (!runtimeMatchesLatest(latest)) {
      const extractedFiles = readdirSync(binDir).join(", ");
      throw new Error(`Runtime extraction completed but expected file hashes do not match. Extracted: ${extractedFiles}`);
    }

    const installedManifestPath = join(runtimeDir, manifestAssetName);
    rmSync(installedManifestPath, { force: true });
    renameSync(manifestPath, installedManifestPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function ensureRuntime() {
  const latest = readLatest();
  const shouldRefresh = process.env.NODE_REPL_RUNTIME_REFRESH === "1";
  if (!shouldRefresh && runtimeMatchesLatest(latest)) {
    return;
  }

  if (!shouldRefresh && hasOverrideRuntime()) {
    return;
  }

  if (isRunningVendoredNode()) {
    throw new Error(
      "Runtime update requires an external Node executable. Install node on PATH or set NODE_REPL_NODE_PATH.",
    );
  }

  let lockHeld = false;
  let heartbeatTimer = undefined;

  try {
    while (!acquireLock()) {
      await waitForRuntimeUpdateLock(latest);
      if (!shouldRefresh && runtimeMatchesLatest(latest)) {
        return;
      }
    }
    lockHeld = true;
    heartbeatTimer = setInterval(writeLockHeartbeat, 2000);

    if (!shouldRefresh && runtimeMatchesLatest(latest)) {
      return;
    }

    await installRuntime(latest);
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    if (lockHeld) {
      releaseLock();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await ensureRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
