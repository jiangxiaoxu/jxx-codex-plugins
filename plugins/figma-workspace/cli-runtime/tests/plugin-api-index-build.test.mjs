import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createPluginApiSymbolRecords,
  stageFigmaPluginApiIndex,
} from "../scripts/build.mjs";

const packageRoot = resolve(import.meta.dirname, "..");

test("Plugin API index v2 records direct owners, declaration kinds, and runtime aliases", () => {
  const records = createPluginApiSymbolRecords([
    {
      sourceFile: "index.d.ts",
      sourceText: [
        "declare global {",
        "  const figma: PluginAPI",
        "}",
        "export {}",
        "",
      ].join("\n"),
    },
    {
      sourceFile: "plugin-api.d.ts",
      sourceText: [
        "interface PluginAPI {",
        "  createFrame(): FrameNode",
        "  readonly variables: VariablesAPI",
        "}",
        "interface VariablesAPI {",
        "  createVariableCollection(name: string): VariableCollection",
        "}",
        "interface ComponentNode {",
        "  createInstance(): InstanceNode",
        "}",
        "type SceneNode = FrameNode | ComponentNode",
        "",
      ].join("\n"),
    },
  ]);

  const createFrame = records.find((record) =>
    record.symbol === "createFrame" && record.ownerSymbol === "PluginAPI");
  assert.deepEqual(createFrame.qualifiedAliases, ["PluginAPI.createFrame", "figma.createFrame"]);
  assert.equal(createFrame.schemaVersion, 2);
  assert.equal(createFrame.declarationKind, "method");

  const createVariableCollection = records.find((record) =>
    record.symbol === "createVariableCollection");
  assert.equal(createVariableCollection.ownerSymbol, "VariablesAPI");
  assert.deepEqual(createVariableCollection.qualifiedAliases, [
    "VariablesAPI.createVariableCollection",
    "figma.variables.createVariableCollection",
  ]);

  const createInstance = records.find((record) => record.symbol === "createInstance");
  assert.equal(createInstance.ownerSymbol, "ComponentNode");
  assert.deepEqual(createInstance.qualifiedAliases, ["ComponentNode.createInstance"]);

  const sceneNode = records.find((record) => record.symbol === "SceneNode");
  assert.equal(sceneNode.ownerSymbol, null);
  assert.equal(sceneNode.declarationKind, "type-alias");
  assert.deepEqual(sceneNode.qualifiedAliases, []);
  assert.match(sceneNode.id, /^@figma\/plugin-typings\/plugin-api\.d\.ts:\d+:SceneNode$/u);
});

test("Plugin API index v2 derives expected aliases from bundled Figma typings", async () => {
  const typingsRoot = resolve(packageRoot, "node_modules/@figma/plugin-typings");
  const sourceInputs = await Promise.all(["index.d.ts", "plugin-api.d.ts"].map(async (sourceFile) => ({
    sourceFile,
    sourceText: (await readFile(resolve(typingsRoot, sourceFile), "utf8")).replace(/\r\n/gu, "\n"),
  })));
  const records = createPluginApiSymbolRecords(sourceInputs);

  const pluginCreateFrame = records.find((record) =>
    record.symbol === "createFrame" && record.ownerSymbol === "PluginAPI");
  assert.ok(pluginCreateFrame);
  assert.equal(pluginCreateFrame.declarationKind, "method");
  assert.ok(pluginCreateFrame.qualifiedAliases.includes("PluginAPI.createFrame"));
  assert.ok(pluginCreateFrame.qualifiedAliases.includes("figma.createFrame"));

  const variablesCreateCollection = records.find((record) =>
    record.symbol === "createVariableCollection" && record.ownerSymbol === "VariablesAPI");
  assert.ok(variablesCreateCollection);
  assert.ok(variablesCreateCollection.qualifiedAliases.includes("figma.variables.createVariableCollection"));

  const componentCreateInstance = records.find((record) =>
    record.symbol === "createInstance" && record.ownerSymbol === "ComponentNode");
  assert.ok(componentCreateInstance);
  assert.deepEqual(componentCreateInstance.qualifiedAliases, ["ComponentNode.createInstance"]);

  assert.ok(records.length > 1_000);
  assert.ok(records.every((record) => record.schemaVersion === 2));
  assert.ok(records.every((record) => typeof record.ownerSymbol === "string" || record.ownerSymbol === null));
  assert.ok(records.every((record) => Array.isArray(record.qualifiedAliases)));
});

test("Plugin API index publisher writes a content-addressed schema v2 index", async () => {
  const typingsRoot = resolve(packageRoot, "node_modules/@figma/plugin-typings");
  const target = await mkdtemp(join(tmpdir(), "figma-plugin-api-index-v2-"));
  try {
    await stageFigmaPluginApiIndex(typingsRoot, target);
    const manifest = JSON.parse(await readFile(resolve(target, "manifest.json"), "utf8"));
    const indexText = await readFile(resolve(target, manifest.index.file), "utf8");
    const records = indexText.trimEnd().split("\n").map((line) => JSON.parse(line));

    assert.equal(manifest.schemaVersion, 2);
    assert.match(manifest.index.file, /^index-[a-f0-9]{64}\.jsonl$/u);
    assert.equal(manifest.index.recordCount, records.length);
    assert.equal(manifest.index.sha256, sha256(indexText));
    assert.equal(manifest.index.file, `index-${manifest.index.sha256}.jsonl`);
    assert.deepEqual(
      Object.keys(manifest.integrity.contentHashes).sort(),
      records.map((record) => record.id).sort(),
    );
    assert.ok(records.every((record) => record.schemaVersion === 2));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
