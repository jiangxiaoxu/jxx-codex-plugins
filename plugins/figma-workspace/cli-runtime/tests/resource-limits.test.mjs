import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createFigmaWorkspaceClient } from "../dist/runtime/workspace-runtime.js";

const MIB = 1024 * 1024;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP2PAAAAAElFTkSuQmCC", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');

test("download preserves upstream svgAssets as typed, bounded files", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-svg-"));
  const outputDir = resolve(tempDir, "downloads");
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/vector")) {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end(SVG);
      return;
    }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  const baseUrl = await listen(server);
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: {
        export: { url: `${baseUrl}/export.png`, format: "png" },
        rawImages: [{ url: `${baseUrl}/source.png`, format: "png" }],
        svgAssets: [{ url: `${baseUrl}/vector?id=icon`, format: "svg", name: "Icon" }],
      },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadSvgFileKey1234", nodeId: "7:7" } }],
      outputDir,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      result.targets[0].downloadedFiles.map(({ kind, format, path }) => [kind, format, path]),
      [
        ["exported", "png", resolve(outputDir, "7-7", "exported.png")],
        ["raw", "png", resolve(outputDir, "7-7", "raw-1.png")],
        ["svg", "svg", resolve(outputDir, "7-7", "svg-1.svg")],
      ],
    );
    assert.deepEqual(await readFile(resolve(outputDir, "7-7", "svg-1.svg")), SVG);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("download fails visibly when an svgAssets entry has no supported URL", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-svg-shape-"));
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { svgAssets: [{ format: "svg", content: "<svg/>" }] },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadSvgShapeKey123", nodeId: "8:8" } }],
      outputDir: resolve(tempDir, "downloads"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.targets[0].downloadedFiles.length, 0);
    assert.match(result.targets[0].downloadError.message, /svgAssets.*without a supported downloadable URL/iu);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "FIGMA_WORKSPACE_DOWNLOAD_SVG_ASSET_SHAPE_UNSUPPORTED"
      && diagnostic.severity === "fatal"));
    assert.ok(result.outputFiles?.debugFile?.path);
    assert.match(await readFile(result.outputFiles.debugFile.path, "utf8"), /<svg\/>/u);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset apply rejects SVG before requesting an upstream upload", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-svg-"));
  const assetPath = resolve(tempDir, "asset.svg");
  await writeFile(assetPath, SVG);
  let upstreamCalls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => {
      upstreamCalls += 1;
      throw new Error("unexpected upstream call");
    }),
  });
  try {
    await assert.rejects(
      client.applyAssetManifest({
        file: "UploadSvgFileKey123456",
        surface: "design",
        assets: [{ path: assetPath, target: { fileKey: "UploadSvgFileKey123456", nodeId: "9:9" } }],
        validateTargets: false,
      }),
      /SVG is not supported by figma:assets:apply.*figma:run/iu,
    );
    assert.equal(upstreamCalls, 0);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset apply rejects SVG content disguised with a raster extension before upstream discovery", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-disguised-svg-"));
  const assetPath = resolve(tempDir, "asset.png");
  await writeFile(
    assetPath,
    Buffer.from('\ufeff  \r\n<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported vector -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY label "icon">]>\n<svg xmlns="http://www.w3.org/2000/svg"><title>&label;</title><path d="M0 0h1v1H0z"/></svg>'),
  );
  let listed = 0;
  let upstreamCalls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => {
      upstreamCalls += 1;
      throw new Error("unexpected upstream call");
    }, {
      beforeListTools() { listed += 1; },
    }),
  });
  try {
    await assert.rejects(
      client.applyAssetManifest({
        file: "UploadSvgFileKey123456",
        surface: "design",
        assets: [{ path: assetPath, target: { fileKey: "UploadSvgFileKey123456", nodeId: "9:10" } }],
        validateTargets: false,
      }),
      /contains an SVG document.*SVG is not supported by figma:assets:apply.*figma:run/iu,
    );
    assert.equal(listed, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("SVG sniff does not reject a non-SVG DOCTYPE or known raster signature", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-svg-negative-"));
  const htmlPath = resolve(tempDir, "document.png");
  const rasterPath = resolve(tempDir, "raster.png");
  await writeFile(htmlPath, Buffer.from('<?xml version="1.0"?><!DOCTYPE html><svg></svg>'));
  await writeFile(rasterPath, Buffer.concat([PNG, Buffer.from('<!DOCTYPE svg><svg></svg>')]));
  let listed = 0;
  let upstreamCalls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => {
      upstreamCalls += 1;
      return textResult({ ok: false, error: { code: "EXPECTED", message: "Sniff accepted input." } });
    }, {
      beforeListTools() { listed += 1; },
    }),
  });
  try {
    const result = await client.applyAssetManifest({
      file: "UploadSvgFileKey123456",
      surface: "design",
      assets: [
        { path: htmlPath, target: { fileKey: "UploadSvgFileKey123456", nodeId: "9:11" } },
        { path: rasterPath, target: { fileKey: "UploadSvgFileKey123456", nodeId: "9:12" } },
      ],
      validateTargets: false,
    });
    assert.equal(result.ok, false);
    assert.equal(listed, 1);
    assert.equal(upstreamCalls, 2);
    assert.doesNotMatch(JSON.stringify(result), /contains an SVG document/iu);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

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

test("asset upload accepts the 10,000,000-byte upstream boundary and streams an exact Content-Length", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-stream-"));
  const assetPath = resolve(tempDir, "asset.png");
  const payload = Buffer.alloc(10_000_000, 0x5a);
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
  const callArguments = [];
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), ({ name, args }) => {
      calls.push(name);
      callArguments.push(args);
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
    assert.deepEqual(callArguments, [{
      fileKey: "UploadStreamFileKey123",
      count: 1,
      nodeIds: ["1:1"],
      scaleMode: "FILL",
    }]);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset upload rejects 10,000,001 bytes before upstream discovery or streaming", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-over-limit-"));
  const assetPath = resolve(tempDir, "asset.png");
  await writeFile(assetPath, Buffer.alloc(10_000_001, 0x5a));
  let listed = 0;
  let calls = 0;
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), () => { calls += 1; throw new Error("unexpected upload"); }, {
      beforeListTools() { listed += 1; },
    }),
  });
  try {
    await assert.rejects(
      client.applyAssetManifest({
        file: "UploadLimitFileKey12345",
        surface: "design",
        assets: [{ path: assetPath, target: { fileKey: "UploadLimitFileKey12345", nodeId: "1:1" } }],
        validateTargets: false,
      }),
      /per-item limit/iu,
    );
    assert.equal(listed, 0);
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asset upload accepts 64 manifest items as 64 sequential count-one nodeIds requests", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-upload-64-"));
  const assetPath = resolve(tempDir, "asset.png");
  await writeFile(assetPath, PNG);
  let uploads = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      uploads += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, imageHash: `hash-${uploads}` }));
    });
  });
  const baseUrl = await listen(server);
  const argumentsByCall = [];
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(uploadTools(), ({ args }) => {
      argumentsByCall.push(args);
      return textResult({ ok: true, result: { uploads: [{ uploadUrl: `${baseUrl}/upload` }] } });
    }),
  });
  try {
    const result = await client.applyAssetManifest({
      file: "UploadSixtyFourFileKey",
      surface: "design",
      outputDir: tempDir,
      validateTargets: false,
      assets: Array.from({ length: 64 }, (_, index) => ({
        path: assetPath,
        target: { fileKey: "UploadSixtyFourFileKey", nodeId: `7:${index + 1}` },
      })),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(uploads, 64);
    assert.equal(argumentsByCall.length, 64);
    assert.deepEqual(argumentsByCall, Array.from({ length: 64 }, (_, index) => ({
      fileKey: "UploadSixtyFourFileKey",
      count: 1,
      nodeIds: [`7:${index + 1}`],
      scaleMode: "FILL",
    })));
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

test("SVG download rejects oversized Content-Length before writing a partial target", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-limit-"));
  const outputDir = resolve(tempDir, "downloads");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "image/svg+xml",
      "content-length": String(16 * MIB + 1),
    });
    response.flushHeaders();
    response.write(PNG);
  });
  const baseUrl = await listen(server);
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { svgAssets: [{ url: `${baseUrl}/oversized.svg`, format: "svg" }] },
    })),
  });
  try {
    const result = await client.downloadAssets({
      targets: [{ target: { fileKey: "DownloadLimitFileKey123", nodeId: "2:2" } }],
      outputDir,
    });
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result), /16 MiB per-item limit/iu);
    await assert.rejects(readFile(resolve(outputDir, "2-2", "svg-1.svg")), { code: "ENOENT" });
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

test("SVG download cancels the response body when the local managed writer fails", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-workspace-download-cancel-"));
  const outputDir = resolve(tempDir, "downloads");
  await mkdir(resolve(outputDir, "6-6", "svg-1.svg"), { recursive: true });
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(PNG); },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "image/svg+xml" } });
  const client = createFigmaWorkspaceClient({
    client: fakeUpstream(downloadTools(), () => textResult({
      ok: true,
      result: { svgAssets: [{ url: "https://example.invalid/vector.svg", format: "svg" }] },
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
        nodeId: { type: "string" }, nodeIds: { type: "array", items: { type: "string" } }, scaleMode: { type: "string" },
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
