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

test("metadata schema excludes retired client hints", () => {
  const descriptions = metadata.createReplToolDescriptions({});
  const byName = new Map(descriptions.map((description) => [description.name, description]));
  const metadataProperties = byName.get("figma_workspace_get_metadata").inputSchema.properties;
  assert.equal("clientLanguages" in metadataProperties, false);
  assert.equal("clientFrameworks" in metadataProperties, false);
});

test("target schemas publish the official file-key and node-id patterns", () => {
  const descriptions = metadata.createReplToolDescriptions({});
  const byName = new Map(descriptions.map((description) => [description.name, description]));
  const schema = byName.get("figma_workspace_get_design_context").inputSchema;
  assert.equal(schema.properties.file.oneOf[0].pattern, "^[0-9a-zA-Z]{22,128}$");
  assert.equal(schema.properties.nodeId.pattern, "^(?:\\d+[:-]\\d+|[IT]\\d+[:-]\\d+(?:;\\d+[:-]\\d+)*)$");
  assert.equal(schema.properties.target.oneOf[0].pattern, schema.properties.nodeId.pattern);
  assert.equal(schema.properties.target.oneOf[2].properties.fileKey.pattern, schema.properties.file.oneOf[0].pattern);
  assert.equal(schema.properties.target.oneOf[2].properties.nodeId.pattern, schema.properties.nodeId.pattern);
  const metadataSchema = byName.get("figma_workspace_get_metadata").inputSchema;
  assert.equal(metadataSchema.properties.nodeId.pattern, schema.properties.nodeId.pattern);
  assert.equal(metadataSchema.properties.target.oneOf[2].properties.nodeId.pattern, schema.properties.nodeId.pattern);
  const motionSchema = byName.get("figma_workspace_get_motion_context").inputSchema;
  assert.equal(motionSchema.properties.nodeId.pattern, "^\\d+[:-]\\d+$");
  assert.equal(motionSchema.properties.target.oneOf[0].pattern, motionSchema.properties.nodeId.pattern);
  assert.equal(motionSchema.properties.target.oneOf[2].properties.nodeId.pattern, motionSchema.properties.nodeId.pattern);
});

test("asset descriptions preserve raster-fill upload and typed SVG download semantics", () => {
  const descriptions = metadata.createReplToolDescriptions({});
  const byName = new Map(descriptions.map((description) => [description.name, description]));
  assert.match(byName.get("figma_workspace_apply_asset_manifest").description, /raster.*fills.*SVG input is not accepted/iu);
  assert.match(byName.get("figma_workspace_download_assets").description, /original raster source images.*vector-layer SVG assets/iu);
});
