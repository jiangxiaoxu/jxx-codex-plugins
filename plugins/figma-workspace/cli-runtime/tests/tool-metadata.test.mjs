import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-tool-metadata-"));
const compiledFile = resolve(temporaryRoot, "tool-metadata.mjs");

await build({
  entryPoints: [resolve(packageRoot, "src/contract/tool-metadata.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});
const metadata = await import(pathToFileURL(compiledFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("numeric tool schemas match clamp and strict runtime boundaries", () => {
  const descriptions = metadata.createReplToolDescriptions({
    taskWorkspaceRootEnv: "IGNORED",
    defaultDocsSearchMaxResults: 999,
    maxDocsSearchResults: 999,
    defaultDocsSearchSnippetLines: 999,
    maxDocsSearchSnippetLines: 999,
    maxLookupQueryLength: 999,
  });
  const byName = new Map(descriptions.map((description) => [description.name, description]));
  const property = (toolName, propertyName) =>
    byName.get(toolName).inputSchema.properties[propertyName];

  for (const [toolName, propertyName, supportedRange] of [
    ["figma_workspace_lookup", "maxResults", "1..10"],
    ["figma_workspace_lookup", "maxSnippetLines", "1..16"],
    ["figma_workspace_docs", "limit", "1..100"],
  ]) {
    const schema = property(toolName, propertyName);
    assert.equal(schema.type, "integer");
    assert.equal(schema.minimum, Number.MIN_SAFE_INTEGER);
    assert.equal(schema.maximum, Number.MAX_SAFE_INTEGER);
    assert.match(schema.description, /Safe integers are accepted/u);
    assert.ok(schema.description.includes(supportedRange));
  }

  for (const [toolName, propertyName, minimum, maximum] of [
    ["figma_workspace_capture_node", "maxDimension", 1, 65_536],
    ["figma_workspace_inspect", "depth", 1, Number.MAX_SAFE_INTEGER],
    ["figma_workspace_get_libraries", "offset", 0, Number.MAX_SAFE_INTEGER],
    ["figma_workspace_run", "inlineResultLimit", 0, 10_000],
  ]) {
    const schema = property(toolName, propertyName);
    assert.equal(schema.type, "integer");
    assert.equal(schema.minimum, minimum);
    assert.equal(schema.maximum, maximum);
  }
});
