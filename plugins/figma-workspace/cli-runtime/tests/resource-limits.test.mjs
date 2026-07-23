import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createFigmaWorkspaceClient } from "../dist/runtime/workspace-runtime.js";

const MIB = 1024 * 1024;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");

test("asset and download manifests reject more than 64 items", async () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]) });
  try {
    await assert.rejects(
      client.applyAssetManifest({
        file: "ManifestLimitFileKey123",
        surface: "design",
        assets: Array.from({ length: 65 }, (_, index) => ({
          path: resolve(tmpdir(), `asset-${index}.png`),
          target: { fileKey: "ManifestLimitFileKey123", nodeId: `1:${index + 1}` },
        })),
        validateTargets: false,
      }),
      /at most 64/iu,
    );
    await assert.rejects(
      client.downloadAssets({
        targets: Array.from({ length: 65 }, (_, index) => ({
          target: { fileKey: "ManifestLimitFileKey123", nodeId: `2:${index + 1}` },
        })),
      }),
      /at most 64/iu,
    );
  } finally {
    await client.close();
  }
});

test("download manifest accepts exactly 64 items", async () => {
  let calls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => {
      calls += 1;
      return textResult({ ok: false, error: { code: "EXPECTED", message: "No download for limit test." } });
    }),
  });
  try {
    const result = await client.downloadAssets({
      targets: Array.from({ length: 64 }, (_, index) => ({
        target: { fileKey: "ManifestBoundaryFileKey123", nodeId: `4:${index + 1}` },
      })),
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 64);
    assert.doesNotMatch(JSON.stringify(result), /resource limit|at most 64/iu);
  } finally {
    await client.close();
  }
});

test("asset manifest files accept exactly 256 KiB and reject 256 KiB plus one byte", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-manifest-limit-"));
  const assetPath = resolve(tempDir, "asset.png");
  const boundaryPath = resolve(tempDir, "boundary.json");
  const manifestPath = resolve(tempDir, "oversized.json");
  await writeFile(assetPath, PNG);
  const boundaryManifest = {
    assets: [{
      path: assetPath,
      target: { fileKey: "ManifestBoundaryFileKey123", nodeId: "1:1" },
    }],
    padding: "",
  };
  const unpadded = JSON.stringify(boundaryManifest);
  boundaryManifest.padding = "x".repeat(256 * 1024 - Buffer.byteLength(unpadded, "utf8"));
  const boundarySource = JSON.stringify(boundaryManifest);
  assert.equal(Buffer.byteLength(boundarySource, "utf8"), 256 * 1024);
  await writeFile(boundaryPath, boundarySource);
  await writeFile(manifestPath, Buffer.alloc(256 * 1024 + 1, 0x20));
  let upstreamCalls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => {
      upstreamCalls += 1;
      return textResult({ ok: false, error: { code: "EXPECTED", message: "Boundary accepted." } });
    }),
  });
  try {
    const boundary = await client.applyAssetManifest({ file: "ManifestBoundaryFileKey123", surface: "design", manifestPath: boundaryPath, validateTargets: false, outputDir: tempDir });
    assert.equal(boundary.ok, false);
    assert.equal(upstreamCalls, 1);
    assert.doesNotMatch(JSON.stringify(boundary), /resource limit|256 KiB per-item limit/iu);

    const result = await client.applyAssetManifest({ file: "ManifestBoundaryFileKey123", surface: "design", manifestPath, validateTargets: false, outputDir: tempDir });
    assert.equal(result.ok, false);
    assert.equal(upstreamCalls, 1);
    assert.match(result.diagnostics[0].message, /256 KiB per-item limit/iu);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset upload accepts the 16 MiB boundary and streams an exact Content-Length", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-stream-"));
  const assetPath = resolve(tempDir, "asset.png");
  const payload = Buffer.alloc(16 * MIB, 0x5a);
  await writeFile(assetPath, payload);
  let receivedBytes = 0;
  let receivedLength;
  const server = createServer((request, response) => {
    receivedLength = request.headers["content-length"];
    request.on("data", (chunk) => { receivedBytes += chunk.length; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, imageHash: "streamed-hash" }));
    });
  });
  const baseUrl = await listen(server);
  const calls = [];
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), ({ name }) => {
      calls.push(name);
      return textResult({ ok: true, result: { uploads: [{ uploadUrl: `${baseUrl}/upload` }] } });
    }),
  });
  try {
    const result = await client.applyAssetManifest({
      file: "UploadStreamFileKey123",
      surface: "design",
      outputDir: tempDir,
      assets: [{
        path: assetPath,
        target: { fileKey: "UploadStreamFileKey123", nodeId: "1:1" },
      }],
      validateTargets: false,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(receivedLength, String(payload.byteLength));
    assert.equal(receivedBytes, payload.byteLength);
    assert.deepEqual(calls, ["upload_assets"]);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset upload keeps the safely opened file handle across a path-to-symlink swap", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-toctou-"));
  const workspaceDir = resolve(tempDir, "workspace");
  const assetPath = resolve(workspaceDir, "asset.png");
  const heldPath = resolve(workspaceDir, "asset-held.png");
  const externalPath = resolve(tempDir, "external.png");
  const expected = Buffer.from("safe-opened-input");
  await mkdir(workspaceDir);
  await writeFile(assetPath, expected);
  await writeFile(externalPath, Buffer.from("unsafe-replacement"));
  let received = Buffer.alloc(0);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });
  });
  const baseUrl = await listen(server);
  let swapped = false;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => textResult({
      ok: true,
      result: { uploads: [{ uploadUrl: `${baseUrl}/upload` }] },
    }), {
      async beforeListTools() {
        try {
          await rename(assetPath, heldPath);
          try {
            await symlink(externalPath, assetPath, "file");
          } catch (error) {
            await rename(heldPath, assetPath);
            throw error;
          }
          swapped = true;
        } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
        }
      },
    }),
  });
  try {
    const result = await client.applyAssetManifest({
      file: "UploadToctouFileKey123",
      surface: "design",
      outputDir: workspaceDir,
      assets: [{ path: assetPath, target: { fileKey: "UploadToctouFileKey123", nodeId: "1:1" } }],
      validateTargets: false,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(received, expected);
    if (swapped) assert.equal((await lstat(assetPath)).isSymbolicLink(), true);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("download rejects oversized Content-Length before writing a partial target", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-limit-"));
  const outputDir = resolve(tempDir, "downloads");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(16 * MIB + 1),
    });
    response.flushHeaders();
    response.write(PNG);
  });
  const baseUrl = await listen(server);
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { exports: [{ url: `${baseUrl}/oversized.png`, format: "png" }] },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadLimitFileKey123", nodeId: "2:2" } }],
      outputDir,
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /16 MiB per-item limit/iu);
    await assert.rejects(readFile(resolve(outputDir, "2-2", "exported.png")), { code: "ENOENT" });
    const files = await listFilesIfPresent(outputDir);
    assert.deepEqual(files.filter((name) => !name.endsWith(".downloads.result.json")), []);
    assert.equal(files.some((name) => name.endsWith(".downloads.result.json")), true);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("interrupted chunked downloads do not leave partial target files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-interrupt-"));
  const outputDir = resolve(tempDir, "downloads");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(PNG);
    setImmediate(() => response.socket?.destroy());
  });
  const baseUrl = await listen(server);
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { exports: [{ url: `${baseUrl}/interrupted.png`, format: "png" }] },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadInterruptFileKey123", nodeId: "5:5" } }],
      outputDir,
    });
    assert.equal(result.ok, false);
    await assert.rejects(readFile(resolve(outputDir, "5-5", "exported.png")), { code: "ENOENT" });
    const files = await listFilesIfPresent(outputDir);
    assert.deepEqual(files.filter((name) => !name.endsWith(".downloads.result.json")), []);
    assert.equal(files.some((name) => name.endsWith(".downloads.result.json")), true);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("download cancels the response body when the local managed writer fails", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-cancel-"));
  const outputDir = resolve(tempDir, "downloads");
  await mkdir(resolve(outputDir, "6-6", "exported.png"), { recursive: true });
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(PNG); },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "image/png" } });
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { exports: [{ url: "https://example.invalid/exported.png", format: "png" }] },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadCancelFileKey123", nodeId: "6:6" } }],
      outputDir,
    });
    assert.equal(result.ok, false);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("capture rejects decoded payloads over 16 MiB without creating an output file", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-capture-limit-"));
  const outputFile = resolve(tempDir, "oversized.png");
  const oversizedBase64 = Buffer.alloc(16 * MIB + 1, 0x41).toString("base64");
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(captureTools(), () => ({
      content: [{ type: "image", mimeType: "image/png", data: oversizedBase64 }],
    })),
  });
  try {
    const result = await client.captureNode({
      target: { fileKey: "CaptureLimitFileKey123", nodeId: "3:3" },
      imageFile: outputFile,
    });
    assert.equal(result.ok, false);
    assert.match(result.upstreamError.message, /16 MiB per-item limit/iu);
    await assert.rejects(readFile(outputFile), { code: "ENOENT" });
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

function fakeUpstream(tools, callTool = () => { throw new Error("unexpected upstream call"); }, options = {}) {
  return {
    async connect() {},
    async close() {},
    async listTools() { await options.beforeListTools?.(); return { tools }; },
    async callTool(name, args) { return callTool({ name, args }); },
  };
}

function uploadTools() {
  return [{
    name: "upload_assets",
    inputSchema: {
      type: "object",
      properties: {
        fileKey: { type: "string" }, count: { type: "number" },
        nodeId: { type: "string" }, scaleMode: { type: "string" },
      },
    },
  }];
}

function downloadTools() {
  return [{
    name: "download_assets",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
      required: ["fileKey", "nodeId"],
    },
  }];
}

function captureTools() {
  return [{
    name: "get_screenshot",
    inputSchema: {
      type: "object",
      properties: { fileKey: { type: "string" }, nodeId: { type: "string" } },
      required: ["fileKey", "nodeId"],
    },
  }];
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function listFilesIfPresent(root) {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
