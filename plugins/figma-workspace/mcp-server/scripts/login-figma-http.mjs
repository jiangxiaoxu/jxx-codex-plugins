#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AtomicCredentialStore } from "../dist/auth/credential-store.js";

const serverName = "figma-http";
const serverUrl = "http://127.0.0.1:18766/mcp";
const metadataUrl = "http://127.0.0.1:18766/.well-known/oauth-protected-resource";
const oauthCacheFilename = ".figma-workspace-oauth.json";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = resolve(scriptDir, "..");
const pluginRoot = resolve(mcpServerRoot, "..");

export async function main(dependencies = {}) {
  const argv = dependencies.argv ?? process.argv.slice(2);
  const env = dependencies.env ?? process.env;
  const ensureCommandAvailableImpl =
    dependencies.ensureCommandAvailable ?? ensureCommandAvailable;
  const startBridgeImpl = dependencies.startBridge ?? startBridge;
  const invokeCodexMcpImpl = dependencies.invokeCodexMcp ?? invokeCodexMcp;
  const options = parseArgs(argv);
  const resolvedCachePath = resolveOAuthCachePath(env);
  if (!resolvedCachePath) {
    throw new Error(
      "Unable to resolve OAuth cache path. Set FIGMA_WORKSPACE_OAUTH_CACHE_PATH, CODEX_HOME, or USERPROFILE.",
    );
  }

  console.log("Figma MCP login");
  console.log(`Server name: ${serverName}`);
  console.log(`Server URL:  ${serverUrl}`);
  console.log(`CODEX_HOME:  ${env.CODEX_HOME ?? ""}`);
  console.log(`USERPROFILE: ${env.USERPROFILE ?? ""}`);
  console.log(`Cache path:  ${resolvedCachePath}`);
  console.log(`Mode:        ${options.force ? "force reauthorize" : "ensure usable"}`);

  await ensureCommandAvailableImpl("codex");

  const beforeSnapshot = await readOAuthCacheSnapshot(resolvedCachePath);
  let restorePreviousCache = undefined;
  if (options.force) {
    restorePreviousCache = await removeOAuthCacheForForceLogin(resolvedCachePath);
  }

  let bridgeProcess;
  let loginSucceeded = false;
  let flowError;
  try {
    bridgeProcess = await startBridgeImpl();
    await invokeCodexMcpImpl(["mcp", "remove", serverName], { ignoreFailure: true });
    await invokeCodexMcpImpl(["mcp", "add", serverName, "--url", serverUrl]);

    let cacheStatus = await testOAuthCacheReady(resolvedCachePath);
    if (!cacheStatus.ready) {
      console.log(
        `OAuth cache is not ready after adding the temporary server. ${cacheStatus.reason}`,
      );
      await invokeCodexMcpImpl(["mcp", "login", serverName]);
      cacheStatus = await testOAuthCacheReady(resolvedCachePath);
    }

    if (!cacheStatus.ready) {
      console.error(
        `Figma MCP login did not produce a usable OAuth cache. ${cacheStatus.reason}`,
      );
      process.exitCode = 2;
    } else {
      loginSucceeded = true;
      const afterSnapshot = await readOAuthCacheSnapshot(resolvedCachePath);
      reportOAuthCacheWriteStatus(beforeSnapshot, afterSnapshot, options);
      console.log(`OAuth cache ready: ${resolvedCachePath}`);
    }
  } catch (error) {
    flowError = error;
  } finally {
    if (restorePreviousCache && !loginSucceeded) {
      try {
        await restorePreviousCache();
      } catch (rollbackError) {
        flowError = flowError
          ? new AggregateError(
              [flowError, rollbackError],
              "Figma MCP login failed and OAuth cache rollback also failed.",
            )
          : rollbackError;
      }
    }
    await invokeCodexMcpImpl(["mcp", "remove", serverName], { ignoreFailure: true });
    if (bridgeProcess && !bridgeProcess.killed) {
      bridgeProcess.kill();
    }
  }

  if (flowError) {
    throw flowError;
  }
  if (!loginSucceeded) {
    return;
  }

  console.log("");
  console.log(
    "Done. Login completed and the OAuth cache is available for the bridge and Figma Workspace CLI.",
  );
}

function parseArgs(args) {
  const options = { force: false };
  for (const arg of args) {
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run login:figma-http -- [--force]");
      console.log("");
      console.log("Without --force, ensure the OAuth cache is usable and report whether this run changed it.");
      console.log("With --force, install a unique attempt marker before login.");
      console.log("A failed login restores the old cache only when no concurrent credential replaced that marker.");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function resolveOAuthCachePath(env) {
  if (env.FIGMA_WORKSPACE_OAUTH_CACHE_PATH) {
    return env.FIGMA_WORKSPACE_OAUTH_CACHE_PATH;
  }

  if (env.CODEX_HOME) {
    return join(env.CODEX_HOME, oauthCacheFilename);
  }

  if (env.USERPROFILE) {
    return join(env.USERPROFILE, ".codex", oauthCacheFilename);
  }

  return undefined;
}

async function testOAuthCacheReady(path) {
  if (!path) {
    return {
      ready: false,
      reason: "OAuth cache path could not be resolved.",
    };
  }

  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ready: false,
        reason: `OAuth cache file does not exist: ${path}`,
      };
    }
    throw error;
  }

  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return {
      ready: false,
      reason: `OAuth cache file is not valid JSON: ${path}`,
    };
  }

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return {
      ready: false,
      reason: "OAuth cache file does not contain a JSON object.",
    };
  }

  if (!state.clientInformation) {
    return {
      ready: false,
      reason: "OAuth cache is missing clientInformation.",
    };
  }

  if (!state.tokens) {
    return {
      ready: false,
      reason: "OAuth cache is missing tokens.",
    };
  }

  const token = state.tokens.access_token;
  if (typeof token !== "string" || token.length === 0) {
    return {
      ready: false,
      reason: "OAuth cache is missing tokens.access_token.",
    };
  }

  const expiresAt = state.tokens.expires_at;
  if (expiresAt !== undefined && expiresAt !== null) {
    const expiresAtNumber = Number(expiresAt);
    if (!Number.isFinite(expiresAtNumber)) {
      return {
        ready: false,
        reason: "OAuth cache tokens.expires_at is not numeric.",
      };
    }

    if (expiresAtNumber <= Date.now() + 60000) {
      return {
        ready: false,
        reason: "OAuth cache access token is expired or expires within 60 seconds.",
      };
    }
  }

  return {
    ready: true,
    reason: "OAuth cache contains a usable access token.",
  };
}

async function readOAuthCacheSnapshot(path) {
  try {
    const [metadata, data] = await Promise.all([
      stat(path),
      readFile(path),
    ]);
    return {
      exists: true,
      hash: createHash("sha256").update(data).digest("hex"),
      mtimeMs: metadata.mtimeMs,
      bytes: data.byteLength,
      data,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        hash: undefined,
        mtimeMs: undefined,
        bytes: 0,
        data: undefined,
      };
    }
    throw error;
  }
}

export async function removeOAuthCacheForForceLogin(path) {
  const store = createOAuthCredentialStore(path);
  const attemptId = randomUUID();
  const markerBytes = Buffer.from(`${JSON.stringify({
    figmaWorkspaceForceLoginAttempt: attemptId,
  })}\n`, "utf8");
  const markerFingerprint = createHash("sha256").update(markerBytes).digest("hex");
  const snapshot = await store.withLock(async (locked) => {
    const current = await locked.readSnapshot();
    await locked.writeBytes(markerBytes);
    return current;
  });

  console.log(
    snapshot.exists
      ? "Force login requested; existing OAuth cache was replaced by an attempt marker before login."
      : "Force login requested; an attempt marker was installed before login.",
  );

  return async () => {
    return store.withLock(async (locked) => {
      const current = await locked.readSnapshot();
      if (current.exists && current.fingerprint !== markerFingerprint) {
        console.error(
          "OAuth cache rollback conflict: credentials changed during force login; preserving the newer cache.",
        );
        return false;
      }

      if (snapshot.exists) {
        if (!snapshot.bytes) {
          throw new Error("OAuth cache snapshot bytes are unavailable for force-login rollback.");
        }
        await locked.writeBytes(snapshot.bytes);
        console.error("Restored the previous OAuth cache after login failure.");
      } else if (current.exists) {
        const removed = await locked.clear(markerFingerprint);
        if (!removed) {
          throw new Error("OAuth cache attempt marker changed during rollback.");
        }
        console.error("Removed the force-login OAuth cache attempt marker after login failure.");
      }
      return true;
    });
  };
}

function createOAuthCredentialStore(path) {
  return new AtomicCredentialStore(path, {
    empty: () => ({}),
    parse(json) {
      const value = JSON.parse(json);
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    },
  });
}

function reportOAuthCacheWriteStatus(beforeSnapshot, afterSnapshot, options) {
  if (!afterSnapshot.exists) {
    console.error("OAuth cache status: missing after login.");
    return;
  }

  if (!beforeSnapshot.exists) {
    console.log("OAuth cache status: created by this login run.");
    return;
  }

  if (
    beforeSnapshot.hash !== afterSnapshot.hash ||
    beforeSnapshot.mtimeMs !== afterSnapshot.mtimeMs ||
    beforeSnapshot.bytes !== afterSnapshot.bytes
  ) {
    console.log("OAuth cache status: updated by this login run.");
    return;
  }

  if (options.force) {
    console.log("OAuth cache status: usable after force login, but content matches the previous cache.");
    return;
  }

  console.log("OAuth cache status: already usable; no new token was written.");
}

async function ensureCommandAvailable(command) {
  await runProcess(command, ["--version"], {
    quiet: true,
    errorMessage: `Cannot find '${command}' on PATH.`,
  });
}

async function testBridgeReady() {
  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(2000) });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function startBridge() {
  if (await testBridgeReady()) {
    console.log(`Bridge already reachable at ${metadataUrl}`);
    return undefined;
  }

  console.log(`Starting local bridge from ${pluginRoot}`);
  const bridgeProcess = spawn(process.execPath, ["scripts/server.mjs"], {
    cwd: pluginRoot,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });

  for (let index = 0; index < 30; index += 1) {
    if (bridgeProcess.exitCode !== null) {
      throw new Error(`Figma MCP bridge exited early with code ${bridgeProcess.exitCode}.`);
    }

    if (await testBridgeReady()) {
      console.log(`Bridge ready at ${metadataUrl}`);
      return bridgeProcess;
    }

    await delay(500);
  }

  if (!bridgeProcess.killed) {
    bridgeProcess.kill();
  }
  throw new Error(`Figma MCP bridge did not become ready at ${metadataUrl}.`);
}

async function invokeCodexMcp(args, options = {}) {
  console.log("");
  console.log(`> codex ${args.join(" ")}`);
  const exitCode = await runProcess("codex", args, {
    ignoreFailure: options.ignoreFailure,
  });

  if (exitCode !== 0 && !options.ignoreFailure) {
    throw new Error(`codex exited with code ${exitCode}`);
  }

  return exitCode;
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.quiet ? "ignore" : "inherit",
      windowsHide: true,
    });

    child.on("error", (error) => {
      if (options.ignoreFailure) {
        resolvePromise(1);
      } else {
        reject(new Error(options.errorMessage ?? error.message));
      }
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        if (options.ignoreFailure) {
          resolvePromise(1);
        } else {
          reject(new Error(`${command} exited due to signal ${signal}`));
        }
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await main().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = process.exitCode || 1;
  });
}
