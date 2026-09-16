import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-json-command-contract-"));
const contractsFile = resolve(temporaryRoot, "json-command-contracts.mjs");
const argsFile = resolve(temporaryRoot, "tool-args.mjs");
const commandRuntimeFile = resolve(temporaryRoot, "figma-command-runtime.mjs");
const registryFile = resolve(temporaryRoot, "public-command-registry.mjs");
const validatorFile = resolve(temporaryRoot, "json-command-validator.mjs");

await Promise.all([
  build({
    entryPoints: [resolve(packageRoot, "src/contract/json-command-contracts.ts")],
    outfile: contractsFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
  }),
  build({
    entryPoints: [resolve(packageRoot, "src/contract/tool-args.ts")],
    outfile: argsFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
  }),
  build({
    entryPoints: [resolve(packageRoot, "src/cli/figma-command-runtime.ts")],
    outfile: commandRuntimeFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    banner: { js: 'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module"; import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url"; import { dirname as __figmaWorkspacePathDirname } from "node:path"; const require = __figmaWorkspaceCreateRequire(import.meta.url); const __filename = __figmaWorkspaceFileURLToPath(import.meta.url); const __dirname = __figmaWorkspacePathDirname(__filename);' },
  }),
  build({
    entryPoints: [resolve(packageRoot, "src/runtime/public-command-registry.ts")],
    outfile: registryFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
  }),
  build({
    entryPoints: [resolve(packageRoot, "src/contract/json-command-validator.ts")],
    outfile: validatorFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
  }),
]);

const contracts = await import(pathToFileURL(contractsFile).href);
const args = await import(pathToFileURL(argsFile).href);
const commandRuntime = await import(pathToFileURL(commandRuntimeFile).href);
const registry = await import(pathToFileURL(registryFile).href);
const validator = await import(pathToFileURL(validatorFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

const FILE_KEY = contracts.FIGMA_JSON_COMMAND_EXAMPLE_FILE_KEY;
const FILE_URL = contracts.FIGMA_JSON_COMMAND_EXAMPLE_FILE_URL;

test("JSON command contracts cover every --input public leaf and expose strict nested shapes", () => {
  const all = contracts.getFigmaJsonCommandContracts();
  const specs = registry.getFigmaPublicCommandSpecs();
  const inputSpecs = specs.filter((spec) => spec.options.includes("input") || Object.values(spec.profiles ?? {}).some((profile) => profile.options.includes("input")));
  const jsonSpecs = inputSpecs;
  assert.doesNotThrow(() => contracts.assertFigmaJsonCommandRegistryConsistency(specs, all));
  assert.deepEqual(Object.keys(all).sort(), jsonSpecs.map((spec) => spec.jsonContract).sort());
  assert.deepEqual(jsonSpecs.map((spec) => spec.name).sort(), Object.keys(all).sort());
  for (const spec of jsonSpecs) {
    const contract = all[spec.jsonContract];
    assert.ok(contract, `${spec.name} has a registry marker without a contract`);
    assert.equal(typeof contract.inputSchema, "object", spec.name);
    assert.equal(typeof contract.example, "object", spec.name);
    const help = commandRuntime.formatCommandHelp(spec.name);
    assert.match(help, /## --input JSON/u, spec.name);
    assert.match(help, /Minimal copyable example:/u, spec.name);
  }

  const apply = all["assets:apply"].inputSchema;
  assert.deepEqual(apply.required, ["assets"]);
  assert.equal("oneOf" in apply, false);
  assert.equal("manifestPath" in apply.properties, false);
  assert.equal(apply.properties.assets.items.required.includes("path"), true);
  assert.equal(apply.properties.assets.items.required.includes("target"), true);
  assert.equal(apply.properties.assets.items.properties.scaleMode.pattern, "^(?:[Ff][Ii][Ll][Ll]|[Ff][Ii][Tt]|[Cc][Rr][Oo][Pp]|[Tt][Ii][Ll][Ee])$");
  assert.equal(apply.properties.assets.items.properties.target.oneOf[2].additionalProperties, false);

  const codeConnect = all["code-connect:plan"].inputSchema;
  assert.deepEqual(codeConnect.required, ["schemaVersion", "scope", "mappings"]);
  assert.deepEqual(codeConnect.properties.mappings.items.required, ["nodeId", "componentName", "source", "label"]);
  assert.equal(codeConnect.properties.mappings.maxItems, 64);

  const upstream = all["upstream:call"].inputSchema;
  assert.deepEqual(upstream.required, ["toolName"]);
  assert.equal(upstream.properties.arguments.additionalProperties, true);
  assert.match(upstream.properties.arguments.description, /live upstream schema/iu);

  assert.equal(all["design-system"].inputSchema.properties.queries.items.additionalProperties, false);
  assert.equal(all["design-system"].inputSchema.properties.queries.minItems, 1);
  assert.equal(FILE_KEY.length, 22);
});

test("JSON registry gate catches missing markers, schemas, examples, and strict schema keywords", () => {
  const specs = registry.getFigmaPublicCommandSpecs();
  const all = contracts.getFigmaJsonCommandContracts();
  const apply = specs.find((spec) => spec.name === "assets:apply");
  assert.ok(apply);
  assert.throws(
    () => contracts.assertFigmaJsonCommandRegistryConsistency(
      specs.map((spec) => spec.name === "assets:apply" ? { ...spec, jsonContract: undefined } : spec),
      all,
    ),
    /accepts --input.*no jsonContract/iu,
  );
  assert.throws(
    () => contracts.assertFigmaJsonCommandRegistryConsistency(
      specs,
      Object.fromEntries(Object.entries(all).filter(([name]) => name !== "assets:apply")),
    ),
    /missing JSON contract|no matching contract/iu,
  );
  assert.throws(
    () => contracts.assertFigmaJsonCommandRegistryConsistency(
      specs,
      Object.fromEntries(Object.entries(all).map(([name, contract]) => [name, name === "assets:apply" ? { ...contract, inputSchema: undefined } : contract])),
    ),
    /must expose an inputSchema/iu,
  );
  assert.throws(
    () => contracts.assertFigmaJsonCommandRegistryConsistency(
      specs.map((spec) => spec.name === "assets:apply" ? { ...spec, jsonExampleArgv: undefined } : spec),
      all,
    ),
    /complete jsonExampleArgv/iu,
  );
  assert.throws(
    () => contracts.assertFigmaJsonCommandRegistryConsistency(
      [...specs, { ...apply, name: "new-json-leaf", id: "figma:new-json-leaf", options: ["input"], flags: [], repeats: [], jsonContract: undefined, jsonExampleArgv: ["--input", "-"] }],
      all,
    ),
    /accepts --input.*no jsonContract/iu,
  );
  assert.throws(
    () => validator.validateFigmaJsonSchema("schema-typo", { type: "object", typoKeyword: true }, {}),
    /strict mode|unknown keyword/iu,
  );
});

test("every copyable JSON example reaches the existing argument validators without Figma I/O", () => {
  const all = contracts.getFigmaJsonCommandContracts();
  const designSystem = all["design-system"].example;
  assert.doesNotThrow(() => args.asSearchDesignSystemArgs({ ...designSystem, file: FILE_URL }));

  const apply = all["assets:apply"].example;
  assert.doesNotThrow(() => args.asApplyAssetManifestArgs({ ...apply, file: FILE_URL }));
  assert.doesNotThrow(() => args.validateAssets([{ path: "assets/tutorial.png", target: contracts.FIGMA_JSON_COMMAND_EXAMPLE_NODE_URL, scaleMode: "FIT" }]));
  assert.doesNotThrow(() => args.asDownloadAssetsArgs({ target: contracts.FIGMA_JSON_COMMAND_EXAMPLE_NODE_URL, defaultFormat: "svg", defaultScale: 2 }));
  assert.doesNotThrow(() => args.asDownloadAssetsArgs({ file: FILE_KEY, target: "1:2" }));

  const manifest = all["code-connect:plan"].example;
  assert.doesNotThrow(() => args.asCodeConnectPlanArgs({ file: FILE_URL, surface: "design", manifest }));

  assert.doesNotThrow(() => args.asCallUpstreamToolArgs(all["upstream:call"].example));
});

test("fixed JSON validators reject malformed nested entries with their JSON paths", () => {
  assert.throws(
    () => args.asApplyAssetManifestArgs({ file: FILE_URL, assets: [{ path: "assets/tutorial.png" }] }),
    /assets\[0\]\.target.*required/iu,
  );
  assert.throws(
    () => args.asApplyAssetManifestArgs({ file: FILE_URL, assets: [{ target: contracts.FIGMA_JSON_COMMAND_EXAMPLE_NODE_URL }] }),
    /assets\[0\]\.path.*required/iu,
  );
  assert.throws(
    () => args.asDownloadAssetsArgs({ target: contracts.FIGMA_JSON_COMMAND_EXAMPLE_NODE_URL, defaultScale: 5 }),
    /defaultScale.*0\.01 to 4/iu,
  );
});

test("public --input parsing accepts every fixed example without connecting to Figma", async () => {
  const inputSpecs = registry.getFigmaPublicCommandSpecs().filter((spec) => spec.options.includes("input") || Object.values(spec.profiles ?? {}).some((profile) => profile.options.includes("input")));
  for (const spec of inputSpecs) {
    const command = spec.name;
    const contract = contracts.getFigmaJsonCommandContract(command);
    assert.ok(Array.isArray(spec.jsonExampleArgv), `${command} must publish parser-ready example argv`);
    const exampleArgv = spec.jsonExampleArgv.map((value) => value === "$EXAMPLE_FILE_URL" ? FILE_URL : value);
    for (const [exampleIndex, example] of [contract.example, ...(contract.examples ?? [])].entries()) {
      const stdout = [];
      const stderr = [];
      const calls = [];
      const dependencies = {
        cwd: () => process.cwd(),
        readStdin: async () => JSON.stringify(example),
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value),
        runCli: async (argv, mapped) => {
          calls.push({ argv: [...argv], input: JSON.parse(await mapped.io.readStdin()) });
          return 0;
        },
      };
      assert.equal(await commandRuntime.runFigmaCommand(command, exampleArgv, dependencies), 0, `${command} example ${exampleIndex}`);
      assert.equal(stderr.length, 0, `${command} example ${exampleIndex}`);
      assert.equal(calls.length, 1, `${command} example ${exampleIndex}`);
      assert.equal(calls[0].input.toolName === undefined || typeof calls[0].input.toolName === "string", true, `${command} example ${exampleIndex}`);
    }
  }
});
