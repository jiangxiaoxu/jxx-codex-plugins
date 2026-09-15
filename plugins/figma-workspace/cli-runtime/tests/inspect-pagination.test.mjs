import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-inspect-pagination-"));
const compiledFile = resolve(temporaryRoot, "inspect-pagination.mjs");

await build({
  entryPoints: [resolve(packageRoot, "src/runtime/inspect-pagination.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});

const pagination = await import(pathToFileURL(compiledFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

const FILE_KEY = "A".repeat(22);
const NODE_ID = "1:1";

test("inspect pagination executes the generated code as bounded full envelopes without truncating Unicode text", async () => {
  const root = {
    id: NODE_ID,
    type: "FRAME",
    name: "Root",
    children: Array.from({ length: 28 }, (_, index) => ({
      id: `1:${index + 2}`,
      type: "TEXT",
      name: `Text ${index}`,
      characters: `${"汉🙂\"\\\n".repeat(310)} node=${index}`,
    })),
  };
  const expectedIds = [root.id, ...root.children.map((child) => child.id)];
  const originalCharacters = root.children[0].characters;
  const fields = ["name", "characters"];
  let page = pagination.resolveInspectPagination({ fileKey: FILE_KEY, nodeId: NODE_ID, depth: 1, fields });
  const observedIds = [];
  let pageCount = 0;

  for (;;) {
    const envelope = await executeGeneratedPage(page, root);
    assert.ok(
      Buffer.byteLength(JSON.stringify(envelope), "utf8") <= pagination.FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES,
      "the actual buildFigmaEvalScript-shaped success envelope stays within the conservative page budget",
    );
    const result = pagination.finalizeInspectPaginationResult(envelope.result, page);
    assert.equal(result.ok, true);
    assert.equal(result.readConsistency, "live");
    assert.deepEqual(result.fields, fields);
    observedIds.push(...result.nodes.map((node) => node.id));
    if (pageCount === 0) {
      assert.equal(result.nodes[0].parentId, null);
      assert.equal(result.nodes[0].childCount, 28);
      assert.equal(result.nodes[1].parentId, root.id);
      assert.equal(result.nodes[1].characters, originalCharacters);
    }
    pageCount += 1;
    if (!result.hasMore) break;
    assert.equal(typeof result.nextCursor, "string");
    page = pagination.resolveInspectPagination({
      fileKey: FILE_KEY,
      nodeId: NODE_ID,
      cursor: result.nextCursor,
    });
  }

  assert.ok(pageCount > 1, "large pages continue explicitly instead of trimming siblings");
  assert.deepEqual(observedIds, expectedIds);
  assert.equal(
    pagination.FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES
      + pagination.FIGMA_WORKSPACE_INSPECT_PAGE_UPSTREAM_RESERVE_BYTES,
    20_000,
  );
});

test("a selected node larger than the budget produces a compact error envelope and does not shorten its text", async () => {
  const sentinel = "FULL_TEXT_MUST_NOT_BE_EMITTED";
  const root = {
    id: NODE_ID,
    type: "TEXT",
    name: "Root",
    characters: `${"汉🙂\"\\\n".repeat(8_000)}${sentinel}`,
    children: [],
  };
  const page = pagination.resolveInspectPagination({
    fileKey: FILE_KEY,
    nodeId: NODE_ID,
    depth: 0,
    fields: ["characters"],
  });
  const envelope = await executeGeneratedPage(page, root);
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= pagination.FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES);
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(sentinel, "u"));
  const result = pagination.finalizeInspectPaginationResult(envelope.result, page);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "FIGMA_WORKSPACE_INSPECT_NODE_TOO_LARGE");
  assert.equal(result.error.details.nodeId, NODE_ID);
  assert.deepEqual(result.error.details.fields, ["characters"]);
  assert.match(result.suggestion, /Remove characters|fewer fields/u);
});

test("inspect cursors bind target, depth, and fields, and report a live offset that no longer exists", async () => {
  const root = {
    id: NODE_ID,
    type: "FRAME",
    name: "Root",
    children: Array.from({ length: 28 }, (_, index) => ({
      id: `1:${index + 2}`,
      type: "TEXT",
      name: `Text ${index}`,
      characters: "x".repeat(1_300),
    })),
  };
  const firstPage = pagination.resolveInspectPagination({
    fileKey: FILE_KEY,
    nodeId: NODE_ID,
    depth: 1,
    fields: ["name", "characters"],
  });
  const firstEnvelope = await executeGeneratedPage(firstPage, root);
  const firstResult = pagination.finalizeInspectPaginationResult(firstEnvelope.result, firstPage);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.hasMore, true);

  assert.throws(
    () => pagination.resolveInspectPagination({
      fileKey: FILE_KEY,
      nodeId: NODE_ID,
      depth: 0,
      cursor: firstResult.nextCursor,
    }),
    /does not match the requested depth/u,
  );
  assert.throws(
    () => pagination.resolveInspectPagination({ fileKey: FILE_KEY, nodeId: "9:9", cursor: firstResult.nextCursor }),
    /does not match the explicit Figma file and node target/u,
  );
  assert.throws(
    () => pagination.resolveInspectPagination({ fileKey: FILE_KEY, nodeId: NODE_ID, cursor: "not-a-cursor" }),
    /malformed/u,
  );

  root.children = [];
  const continuation = pagination.resolveInspectPagination({
    fileKey: FILE_KEY,
    nodeId: NODE_ID,
    cursor: firstResult.nextCursor,
  });
  const errorEnvelope = await executeGeneratedPage(continuation, root);
  assert.ok(Buffer.byteLength(JSON.stringify(errorEnvelope), "utf8") <= pagination.FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES);
  const errorResult = pagination.finalizeInspectPaginationResult(errorEnvelope.result, continuation);
  assert.equal(errorResult.ok, false);
  assert.equal(errorResult.error.code, "FIGMA_WORKSPACE_INSPECT_CURSOR_OUT_OF_RANGE");
  assert.equal(errorResult.error.details.offset, continuation.offset);
  assert.equal(errorResult.error.details.currentNodeCount, 1);
});

test("inspect pagination defaults preserve the existing details while allowing target-only depth zero", () => {
  const defaultPage = pagination.resolveInspectPagination({ fileKey: FILE_KEY, nodeId: NODE_ID });
  assert.equal(defaultPage.depth, 2);
  const page = pagination.resolveInspectPagination({ fileKey: FILE_KEY, nodeId: NODE_ID, depth: 0 });
  assert.equal(page.depth, 0);
  assert.deepEqual(page.fields, [
    "name",
    "visible",
    "x",
    "y",
    "width",
    "height",
    "locked",
    "layoutMode",
    "layoutPositioning",
    "characters",
  ]);
  const selected = pagination.resolveInspectPagination({
    fileKey: FILE_KEY,
    nodeId: NODE_ID,
    fields: ["characters", "name"],
  });
  assert.deepEqual(selected.fields, ["name", "characters"]);
});

async function executeGeneratedPage(page, root) {
  const code = pagination.buildInspectPaginationCode(page);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const source = [
    "const __figmaWorkspace = { invocationId: 'inspect-pagination-test', captureRequests: [] };",
    "async function __figmaWorkspaceResolveNode(value) {",
    "  if (value !== '1:1') throw new Error('unexpected target');",
    "  return figma.root;",
    "}",
    "async function __figmaWorkspaceUserMain() {",
    code,
    "}",
    "const __figmaWorkspaceResult = await __figmaWorkspaceUserMain();",
    "return {",
    "  ok: true,",
    "  __figmaWorkspace: {",
    "    invocationId: __figmaWorkspace.invocationId,",
    "    captureRequests: __figmaWorkspace.captureRequests",
    "  },",
    "  result: __figmaWorkspaceResult",
    "};",
  ].join("\n");
  return new AsyncFunction("figma", source)({ root });
}
