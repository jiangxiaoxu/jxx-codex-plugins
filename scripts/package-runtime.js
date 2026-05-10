#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sevenZip = require("7zip-bin");
const { downloadLatestMsstorePackage } = require("./fetch-msstore");

const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const assetName = "node-repl-runtime-win32-x64.tar.gz";
const manifestName = "node-repl-runtime-win32-x64.manifest.json";
const productId = "9plm9xgg6vks";

function parseArgs(argv) {
  const options = {
    msix: "",
    latestMsstore: false,
    outDir: distDir,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--msix") {
      options.msix = path.resolve(argv[++index]);
    } else if (arg === "--latest-msstore") {
      options.latestMsstore = true;
    } else if (arg === "--out") {
      options.outDir = path.resolve(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/package-runtime.js --msix <path>
  node scripts/package-runtime.js --latest-msstore

Options:
  --out <dir>   Output directory. Defaults to ./dist.`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
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

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensureFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function findFile(root, relativePath) {
  const exact = path.join(root, relativePath);
  if (fs.existsSync(exact)) {
    return exact;
  }

  const target = relativePath.toLowerCase().replaceAll("\\", "/");
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const rel = path.relative(root, fullPath).toLowerCase().replaceAll("\\", "/");
      if (rel === target || rel.endsWith(`/${target}`)) {
        return fullPath;
      }
    }
  }

  return "";
}

function readPackageVersion(msixPath) {
  const baseName = path.basename(msixPath);
  const match = baseName.match(/_(\d+\.\d+\.\d+\.\d+)_/);
  return match?.[1] ?? null;
}

function extractMsix(msixPath, extractDir) {
  ensureFile(msixPath, "MSIX");
  fs.mkdirSync(extractDir, { recursive: true });
  run(sevenZip.path7za, ["x", "-y", `-o${extractDir}`, msixPath]);
}

function createRuntimeArchive(stagingDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const assetPath = path.join(outDir, assetName);
  if (fs.existsSync(assetPath)) {
    fs.rmSync(assetPath, { force: true });
  }
  run("tar", ["-czf", assetPath, "-C", stagingDir, "bin"]);
  return assetPath;
}

async function resolveMsix(options) {
  if (options.msix) {
    return {
      path: options.msix,
      sourcePackage: {
        name: path.basename(options.msix),
        version: readPackageVersion(options.msix),
      },
    };
  }

  if (!options.latestMsstore) {
    throw new Error("Provide --msix <path> or --latest-msstore.");
  }

  const downloadDir = path.join(repoRoot, "downloads");
  const downloaded = await downloadLatestMsstorePackage({
    productId,
    filter: "x64",
    outDir: downloadDir,
  });
  return {
    path: downloaded.path,
    sourcePackage: {
      name: path.basename(downloaded.path),
      version: readPackageVersion(downloaded.path),
      size: downloaded.size ?? null,
      url: downloaded.url,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const msix = await resolveMsix(options);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-repl-package-"));

  try {
    const extractDir = path.join(tmpDir, "msix");
    const stagingDir = path.join(tmpDir, "staging");
    const binDir = path.join(stagingDir, "bin");
    extractMsix(msix.path, extractDir);

    const nodeReplExe = findFile(extractDir, "app/resources/node_repl.exe");
    ensureFile(nodeReplExe, "node_repl.exe");

    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(nodeReplExe, path.join(binDir, "node_repl.exe"));

    const assetPath = createRuntimeArchive(stagingDir, options.outDir);
    const createdAt = new Date().toISOString();
    const releaseTag = `runtime-win32-x64-${msix.sourcePackage.version || createdAt.slice(0, 10)}`;
    const manifest = {
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      releaseTag,
      assetName,
      manifestAssetName: manifestName,
      sha256: sha256(assetPath),
      size: fs.statSync(assetPath).size,
      files: {
        "bin/node_repl.exe": {
          sha256: sha256(path.join(binDir, "node_repl.exe")),
          size: fs.statSync(path.join(binDir, "node_repl.exe")).size,
        },
      },
      source: {
        kind: "msstore-msix",
        productId,
        packageName: msix.sourcePackage.name,
        packageVersion: msix.sourcePackage.version,
        packageSize: msix.sourcePackage.size ?? fs.statSync(msix.path).size,
        packageUrl: msix.sourcePackage.url ?? null,
      },
      createdAt,
    };

    const manifestPath = path.join(options.outDir, manifestName);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`Wrote ${assetPath}`);
    console.log(`Wrote ${manifestPath}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
