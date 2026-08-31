import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-code-connect-test-"));
const compiledFile = resolve(temporaryRoot, "workspace-client.mjs");
const compiledCommandFile = resolve(temporaryRoot, "figma-command-runtime.mjs");

await build({
  entryPoints: [resolve(packageRoot, "src/runtime/workspace-client.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: {
    js: 'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module"; import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url"; import { dirname as __figmaWorkspacePathDirname } from "node:path"; const require = __figmaWorkspaceCreateRequire(import.meta.url); const __filename = __figmaWorkspaceFileURLToPath(import.meta.url); const __dirname = __figmaWorkspacePathDirname(__filename);',
  },
});

await build({
  entryPoints: [resolve(packageRoot, "src/cli/figma-command-runtime.ts")],
  outfile: compiledCommandFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: {
    js: 'import { createRequire as __figmaWorkspaceCreateRequire } from "node:module"; import { fileURLToPath as __figmaWorkspaceFileURLToPath } from "node:url"; import { dirname as __figmaWorkspacePathDirname } from "node:path"; const require = __figmaWorkspaceCreateRequire(import.meta.url); const __filename = __figmaWorkspaceFileURLToPath(import.meta.url); const __dirname = __figmaWorkspacePathDirname(__filename);',
  },
});

const { createFigmaWorkspaceClient } = await import(pathToFileURL(compiledFile).href);
const { runFigmaCommand } = await import(pathToFileURL(compiledCommandFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

const FILE_KEY = "A".repeat(22);
const FILE_URL = `https://www.figma.com/design/${FILE_KEY}/Code-Connect`;
const OTHER_FILE_URL = `https://www.figma.com/design/${"B".repeat(22)}/Other`;
const BRANCH_KEY = "C".repeat(22);
const BRANCH_FILE_URL = `https://www.figma.com/design/${FILE_KEY}/branch/${BRANCH_KEY}/Code-Connect`;
const MAPPING = {
  nodeId: "3:4",
  componentName: "Button",
  source: "src/components/Button.tsx",
  label: "React",
};

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function codeConnectTools() {
  return [
    {
      name: "list_file_components_for_code_connect",
      inputSchema: { type: "object", required: ["fileKey"], properties: { fileKey: {} } },
    },
    {
      name: "get_context_for_code_connect",
      inputSchema: { type: "object", required: ["fileKey", "nodeId"], properties: { fileKey: {}, nodeId: {} } },
    },
    {
      name: "get_code_connect_suggestions",
      inputSchema: {
        type: "object",
        required: ["fileKey", "nodeId"],
        properties: { fileKey: {}, nodeId: {}, excludeMappingPrompt: {} },
      },
    },
    {
      name: "get_code_connect_map",
      inputSchema: {
        type: "object",
        required: ["fileKey", "nodeId"],
        properties: { fileKey: {}, nodeId: {}, codeConnectLabel: {} },
      },
    },
    {
      name: "send_code_connect_mappings",
      inputSchema: {
        type: "object",
        required: ["fileKey", "nodeId", "mappings"],
        properties: {
          fileKey: {},
          nodeId: {},
          mappings: {
            type: "array",
            items: { type: "object", properties: { label: { enum: ["React"] } } },
          },
          clientLanguages: {},
          clientFrameworks: {},
        },
      },
    },
  ];
}

function fakeUpstream(calls, options = {}) {
  let currentMapping = options.initialMapping ?? null;
  return {
    async connect() { calls.push({ kind: "connect" }); },
    async close() { calls.push({ kind: "close" }); },
    async listTools() {
      calls.push({ kind: "listTools" });
      return { tools: codeConnectTools() };
    },
    async callTool(name, args) {
      calls.push({ kind: "call", name, args });
      if (name === "get_context_for_code_connect") {
        if (options.contextError) return { content: [{ type: "text", text: "upstream denied" }], isError: true, _meta: { secret: "must-not-leak" } };
        return textResult({ context: "component context" });
      }
      if (name === "get_code_connect_suggestions") return textResult({ suggestions: [] });
      if (name === "get_code_connect_map") {
        if (options.mapError) return { content: [{ type: "text", text: "mapping denied" }], isError: true, _meta: { secret: "map-must-not-leak" } };
        if (options.unreadableMap) return textResult({ unexpected: "shape" });
        const observedMapping = options.liveMapping ?? currentMapping;
        if (!observedMapping) return textResult({});
        return textResult({ [args.nodeId]: {
          codeConnectSrc: observedMapping.source,
          codeConnectName: observedMapping.componentName,
          ...(options.omitMapLabel ? {} : { codeConnectLabel: observedMapping.label }),
        } });
      }
      if (name === "send_code_connect_mappings") {
        if (options.sendError) throw new Error("send disconnected");
        currentMapping = args.mappings?.[0] ?? null;
        if (options.unreadableAfterSend) options.unreadableMap = true;
        return textResult({ ok: true });
      }
      if (name === "list_file_components_for_code_connect") return textResult({ components: [] });
      throw new Error(`Unexpected upstream tool ${name}`);
    },
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    scope: { nodeId: "1:2" },
    client: { languages: "typescript", frameworks: "react" },
    mappings: [MAPPING],
  };
}

test("Code Connect plan reads context, suggestions, and mappings before writing an artifact", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-plan-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls), invocationId: "code-connect-plan-test" });
  try {
    const result = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "plan.json"), manifest: manifest() });
    assert.equal(result.ok, true);
    assert.equal(result.mappings[0].status, "create");
    assert.match(result.planDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      calls.filter((entry) => entry.kind === "call").map((entry) => entry.name),
      ["get_context_for_code_connect", "get_code_connect_suggestions", "get_code_connect_map"],
    );
    assert.deepEqual(calls.find((entry) => entry.name === "get_context_for_code_connect").args, { fileKey: FILE_KEY, nodeId: "1:2" });
    assert.deepEqual(calls.find((entry) => entry.name === "get_code_connect_suggestions").args, { fileKey: FILE_KEY, nodeId: "1:2", excludeMappingPrompt: true });
    assert.deepEqual(calls.find((entry) => entry.name === "get_code_connect_map").args, { fileKey: FILE_KEY, nodeId: MAPPING.nodeId, codeConnectLabel: MAPPING.label });

    const artifact = JSON.parse(await readFile(result.planFile.path, "utf8"));
    assert.equal(artifact.kind, "figma-code-connect-plan");
    assert.equal(artifact.fileKey, FILE_KEY);
    assert.equal(artifact.actions[0].status, "create");
    assert.equal(artifact.mappings[0].componentName, MAPPING.componentName);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect uses the branch key for inspect, plan artifacts, and apply calls", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-branch-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls), invocationId: "code-connect-branch" });
  try {
    const inspected = await client.codeConnectInspect({ file: BRANCH_FILE_URL, outputDir });
    assert.equal(inspected.fileKey, BRANCH_KEY);
    assert.deepEqual(calls.find((entry) => entry.name === "list_file_components_for_code_connect").args, { fileKey: BRANCH_KEY });

    calls.length = 0;
    const plan = await client.codeConnectPlan({
      file: BRANCH_FILE_URL,
      outputDir,
      outputPlanPath: resolve(outputDir, "branch-plan.json"),
      manifest: manifest(),
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.fileKey, BRANCH_KEY);
    const artifact = JSON.parse(await readFile(plan.planFile.path, "utf8"));
    assert.equal(artifact.fileKey, BRANCH_KEY);
    assert.equal(calls.find((entry) => entry.name === "get_context_for_code_connect").args.fileKey, BRANCH_KEY);
    assert.equal(calls.find((entry) => entry.name === "get_code_connect_map").args.fileKey, BRANCH_KEY);

    calls.length = 0;
    const applied = await client.codeConnectApply({ file: BRANCH_FILE_URL, outputDir, planPath: plan.planFile.path, confirmPlan: plan.planDigest });
    assert.equal(applied.executionOutcome, "succeeded");
    const write = calls.find((entry) => entry.name === "send_code_connect_mappings");
    assert.equal(write.args.fileKey, BRANCH_KEY);
    assert.equal(calls.filter((entry) => entry.name === "get_code_connect_map").every((entry) => entry.args.fileKey === BRANCH_KEY), true);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect accepts a contract-shaped mapping read without a returned label and exposes workflow coverage", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-implicit-label-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls, { initialMapping: MAPPING, omitMapLabel: true }), invocationId: "code-connect-implicit-label" });
  try {
    const plan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "plan.json"), manifest: manifest() });
    assert.equal(plan.ok, true);
    assert.equal(plan.mappings[0].status, "noop");
    for (const [toolName, publicCommands] of [
      ["list_file_components_for_code_connect", ["figma:code-connect:inspect"]],
      ["get_context_for_code_connect", ["figma:code-connect:plan"]],
      ["get_code_connect_suggestions", ["figma:code-connect:plan"]],
      ["get_code_connect_map", ["figma:code-connect:apply", "figma:code-connect:plan", "figma:code-connect:verify"]],
      ["send_code_connect_mappings", ["figma:code-connect:apply"]],
    ]) {
      const coverage = await client.upstreamTools({ name: toolName });
      assert.deepEqual(coverage.coverage, { covered: true, publicCommands }, toolName);
    }
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("explicit CLI --output-plan without --output-dir becomes a readable managed plan artifact", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-cli-plan-"));
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-cli-plan" });
  try {
    let result;
    const exit = await runFigmaCommand("code-connect:plan", [
      "--file", FILE_URL,
      "--input", "-",
      "--output-plan", "plan.json",
    ], {
      cwd: () => outputDir,
      readStdin: async () => JSON.stringify(manifest()),
      writeStdout: () => {},
      writeStderr: () => {},
      runCli: async (_argv, dependencies) => {
        result = await client.codeConnectPlan(JSON.parse(await dependencies.io.readStdin()));
        return 0;
      },
    });
    assert.equal(exit, 0);
    assert.equal(result.ok, true);
    assert.equal(result.planFile.path, resolve(outputDir, "plan.json"));
    assert.equal(JSON.parse(await readFile(result.planFile.path, "utf8")).planDigest, result.planDigest);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect rejects output roots that traverse a symlink or junction", async (t) => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-output-link-"));
  const external = resolve(tempDir, "external");
  const link = resolve(tempDir, "link");
  await mkdir(external);
  try {
    try { await symlink(external, link, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlinks unavailable");
      throw error;
    }
    const client = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-output-link" });
    try {
      await assert.rejects(
        client.codeConnectPlan({ file: FILE_URL, outputDir: resolve(link, "result"), outputPlanPath: resolve(link, "result", "plan.json"), manifest: manifest() }),
        /symlink|junction|reparse/iu,
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Code Connect allows a simulated macOS /var alias and symlinked TMPDIR as a trusted temp root", async (t) => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-temp-alias-"));
  const actualTemp = resolve(tempDir, "private-var", "folders");
  const alias = resolve(tempDir, "var");
  await mkdir(actualTemp, { recursive: true });
  try {
    try { await symlink(resolve(tempDir, "private-var"), alias, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlinks unavailable");
      throw error;
    }
    const original = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]));
    Object.assign(process.env, { TMPDIR: resolve(alias, "folders"), TMP: resolve(alias, "folders"), TEMP: resolve(alias, "folders") });
    try {
      const outputDir = resolve(alias, "folders", "figma-output");
      const client = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-temp-alias" });
      try {
        const result = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "plan.json"), manifest: manifest() });
        assert.equal(result.ok, true);
      } finally {
        await client.close();
      }
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Code Connect manifest canonicalizes node ids before duplicate detection and rejects URL, template, and unknown fields", async () => {
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-manifest-strict" });
  try {
    const valid = manifest();
    valid.mappings = [
      { ...MAPPING, nodeId: "3-4", label: " React " },
      { ...MAPPING, nodeId: " 3:4 ", label: "React" },
    ];
    await assert.rejects(
      client.codeConnectPlan({ file: FILE_URL, manifest: valid }),
      /duplicate mapping identity/iu,
    );
    for (const invalid of [
      { ...manifest(), scope: { nodeId: `${FILE_URL}?node-id=1-2` } },
      { ...manifest(), mappings: [{ ...MAPPING, template: "return {}" }] },
      { ...manifest(), mappings: [{ ...MAPPING, extra: true }] },
      { ...manifest(), mappings: Array.from({ length: 65 }, (_, index) => ({ ...MAPPING, nodeId: `${index + 3}:4` })) },
    ]) {
      await assert.rejects(client.codeConnectPlan({ file: FILE_URL, manifest: invalid }), /Code Connect|does not allow unknown|simple Figma node id/iu);
    }
  } finally {
    await client.close();
  }
});

test("Code Connect canonicalizes hyphenated manifest node ids before upstream map reads and artifact publication", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-node-canonical-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls), invocationId: "code-connect-node-canonical" });
  try {
    const result = await client.codeConnectPlan({
      file: FILE_URL,
      outputDir,
      outputPlanPath: resolve(outputDir, "plan.json"),
      manifest: { ...manifest(), scope: { nodeId: "1-2" }, mappings: [{ ...MAPPING, nodeId: "3-4" }] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.find((entry) => entry.name === "get_code_connect_map").args, {
      fileKey: FILE_KEY,
      nodeId: "3:4",
      codeConnectLabel: "React",
    });
    const artifact = JSON.parse(await readFile(result.planFile.path, "utf8"));
    assert.equal(artifact.scope.nodeId, "1:2");
    assert.equal(artifact.mappings[0].nodeId, "3:4");
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect plan artifact has a bounded 1 MiB limit and remains readable above the manifest input limit", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-plan-size-"));
  const client = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-plan-size" });
  try {
    const largeManifest = {
      ...manifest(),
      mappings: Array.from({ length: 64 }, (_, index) => ({
        ...MAPPING,
        nodeId: `${index + 3}:4`,
        source: `src/${"x".repeat(3_000)}-${index}.tsx`,
      })),
    };
    const plan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "large.json"), manifest: largeManifest });
    assert.equal(plan.ok, true);
    assert.ok(plan.planFile.bytes > 256 * 1024);
    const verification = await client.codeConnectVerify({ file: FILE_URL, outputDir, planPath: plan.planFile.path });
    assert.equal(verification.mappings.length, 64);
    assert.equal(verification.mappings.every((mapping) => mapping.status === "missing"), true);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect apply and verify read an exact 1 MiB plan but reject one additional byte before upstream calls", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-plan-boundary-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls), invocationId: "code-connect-plan-boundary" });
  try {
    const plan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "boundary.json"), manifest: manifest() });
    const source = await readFile(plan.planFile.path, "utf8");
    const padding = 1024 * 1024 - Buffer.byteLength(source, "utf8");
    assert.ok(padding > 0);
    const exactPlan = `${source}${" ".repeat(padding)}`;
    assert.equal(Buffer.byteLength(exactPlan, "utf8"), 1024 * 1024);
    await writeFile(plan.planFile.path, exactPlan, "utf8");

    calls.length = 0;
    const applied = await client.codeConnectApply({
      file: FILE_URL,
      outputDir,
      planPath: plan.planFile.path,
      confirmPlan: plan.planDigest,
    });
    assert.equal(applied.executionOutcome, "succeeded");
    assert.equal(calls.some((entry) => entry.kind === "call"), true);

    await writeFile(plan.planFile.path, `${exactPlan} `, "utf8");
    calls.length = 0;
    const blockedApply = await client.codeConnectApply({
      file: FILE_URL,
      outputDir,
      planPath: plan.planFile.path,
      confirmPlan: plan.planDigest,
    });
    assert.equal(blockedApply.executionOutcome, "not_started");
    assert.equal(calls.some((entry) => entry.kind === "call"), false);

    const blockedVerify = await client.codeConnectVerify({
      file: FILE_URL,
      outputDir,
      planPath: plan.planFile.path,
    });
    assert.equal(blockedVerify.ok, false);
    assert.equal(calls.some((entry) => entry.kind === "call"), false);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect apply rejects a mismatched confirmation without remote calls, then writes once and reads back", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-apply-"));
  const calls = [];
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls), invocationId: "code-connect-apply-test" });
  try {
    const plan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "plan.json"), manifest: manifest() });
    calls.length = 0;

    const rejected = await client.codeConnectApply({
      file: FILE_URL,
      outputDir,
      planPath: plan.planFile.path,
      confirmPlan: "0".repeat(64),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.executionOutcome, "not_started");
    assert.equal(calls.filter((entry) => entry.kind === "call").length, 0);

    calls.length = 0;
    const applied = await client.codeConnectApply({
      file: FILE_URL,
      outputDir,
      planPath: plan.planFile.path,
      confirmPlan: plan.planDigest,
    });
    assert.equal(applied.executionOutcome, "succeeded");
    assert.equal(applied.verification.ok, true);
    assert.equal(calls.filter((entry) => entry.kind === "call" && entry.name === "send_code_connect_mappings").length, 1);
    assert.equal(calls.filter((entry) => entry.kind === "call" && entry.name === "get_code_connect_map").length, 2);
    assert.deepEqual(calls.find((entry) => entry.name === "send_code_connect_mappings").args.mappings, [MAPPING]);
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect apply rejects missing confirmation, tampered or mismatched targets, stale plans, and enforces conflict policy", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-apply-guards-"));
  const calls = [];
  const upstreamOptions = {};
  const client = createFigmaWorkspaceClient({ client: fakeUpstream(calls, upstreamOptions), invocationId: "code-connect-apply-guards" });
  try {
    const plan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "plan.json"), manifest: manifest() });
    calls.length = 0;
    const missing = await client.codeConnectApply({ file: FILE_URL, outputDir, planPath: plan.planFile.path });
    assert.equal(missing.executionOutcome, "not_started");
    assert.equal(calls.length, 0);
    const targetMismatch = await client.codeConnectApply({ file: OTHER_FILE_URL, outputDir, planPath: plan.planFile.path, confirmPlan: plan.planDigest });
    assert.equal(targetMismatch.executionOutcome, "not_started");
    assert.equal(calls.length, 0);

    upstreamOptions.liveMapping = { ...MAPPING, source: "changed-after-plan.tsx" };
    const stale = await client.codeConnectApply({ file: FILE_URL, outputDir, planPath: plan.planFile.path, confirmPlan: plan.planDigest });
    assert.equal(stale.executionOutcome, "not_started");
    assert.equal(stale.mappings[0].status, "mismatch");
    assert.equal(calls.filter((entry) => entry.name === "send_code_connect_mappings").length, 0);
    upstreamOptions.liveMapping = undefined;
    calls.length = 0;

    const artifact = JSON.parse(await readFile(plan.planFile.path, "utf8"));
    artifact.actions[0].status = "replace";
    await writeFile(plan.planFile.path, JSON.stringify(artifact), "utf8");
    const tampered = await client.codeConnectApply({ file: FILE_URL, outputDir, planPath: plan.planFile.path, confirmPlan: plan.planDigest });
    assert.equal(tampered.executionOutcome, "not_started");
    assert.equal(calls.length, 0);

    const nestedPlan = await client.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "nested.json"), manifest: manifest() });
    const nestedSource = await readFile(nestedPlan.planFile.path, "utf8");
    calls.length = 0;
    for (const [field, injected] of [["scope", { nodeId: "1:2", injected: true }], ["client", { languages: "typescript", frameworks: "react", injected: true }]]) {
      const nestedArtifact = JSON.parse(nestedSource);
      nestedArtifact[field] = injected;
      await writeFile(nestedPlan.planFile.path, JSON.stringify(nestedArtifact), "utf8");
      const blocked = await client.codeConnectApply({ file: FILE_URL, outputDir, planPath: nestedPlan.planFile.path, confirmPlan: nestedPlan.planDigest });
      assert.equal(blocked.executionOutcome, "not_started", field);
      assert.equal(calls.length, 0, field);
    }

    const conflictClient = createFigmaWorkspaceClient({ client: fakeUpstream([], { initialMapping: { ...MAPPING, source: "old.tsx" } }), invocationId: "code-connect-conflict" });
    try {
      const conflict = await conflictClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "conflict.json"), manifest: manifest() });
      assert.equal(conflict.mappings[0].status, "conflict");
      const replace = await conflictClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "replace.json"), manifest: { ...manifest(), mappings: [{ ...MAPPING, conflictPolicy: "replace" }] } });
      assert.equal(replace.mappings[0].status, "replace");
    } finally {
      await conflictClient.close();
    }
  } finally {
    await client.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect classifies dispatched write failures and readback failures without replaying", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-outcomes-"));
  try {
    const failingCalls = [];
    const failingClient = createFigmaWorkspaceClient({ client: fakeUpstream(failingCalls, { sendError: true }), invocationId: "code-connect-send-error" });
    const failingPlan = await failingClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "failed.json"), manifest: manifest() });
    const failed = await failingClient.codeConnectApply({ file: FILE_URL, outputDir, planPath: failingPlan.planFile.path, confirmPlan: failingPlan.planDigest });
    assert.equal(failed.executionOutcome, "outcome_unknown");
    assert.equal(failingCalls.filter((entry) => entry.name === "send_code_connect_mappings").length, 1);
    await failingClient.close();

    const readbackCalls = [];
    const readbackClient = createFigmaWorkspaceClient({ client: fakeUpstream(readbackCalls, { unreadableAfterSend: true }), invocationId: "code-connect-readback-failure" });
    const plan = await readbackClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "readback.json"), manifest: manifest() });
    const result = await readbackClient.codeConnectApply({ file: FILE_URL, outputDir, planPath: plan.planFile.path, confirmPlan: plan.planDigest });
    assert.equal(result.executionOutcome, "succeeded");
    assert.equal(result.ok, false);
    assert.equal(readbackCalls.filter((entry) => entry.name === "send_code_connect_mappings").length, 1);
    await readbackClient.close();
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("Code Connect verify returns matched, missing, mismatch, and sanitized remote-error sidecars", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-verify-status-"));
  try {
    for (const [name, initialMapping, expected] of [
      ["matched", MAPPING, "matched"],
      ["missing", null, "missing"],
      ["mismatch", { ...MAPPING, source: "other.tsx" }, "mismatch"],
    ]) {
      const planner = createFigmaWorkspaceClient({ client: fakeUpstream([], { initialMapping: null }), invocationId: `code-connect-verify-plan-${name}` });
      const plan = await planner.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, `${name}.json`), manifest: manifest() });
      await planner.close();
      const verifier = createFigmaWorkspaceClient({ client: fakeUpstream([], { initialMapping }), invocationId: `code-connect-verify-${name}` });
      const result = await verifier.codeConnectVerify({ file: FILE_URL, outputDir, planPath: plan.planFile.path });
      assert.equal(result.mappings[0].status, expected, name);
      await verifier.close();
    }

    const calls = [];
    const errored = createFigmaWorkspaceClient({ client: fakeUpstream(calls, { contextError: true }), invocationId: "code-connect-sidecar" });
    const result = await errored.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "sidecar.json"), manifest: manifest() });
    assert.equal(result.ok, false);
    assert.ok(result.outputFiles?.upstreamFile?.path);
    const sidecar = await readFile(result.outputFiles.upstreamFile.path, "utf8");
    assert.doesNotMatch(sidecar, /must-not-leak|_meta/u);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak|_meta/u);
    await errored.close();

    const planner = createFigmaWorkspaceClient({ client: fakeUpstream([]), invocationId: "code-connect-map-error-plan" });
    const plan = await planner.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "map-error.json"), manifest: manifest() });
    await planner.close();
    const mapErrorClient = createFigmaWorkspaceClient({ client: fakeUpstream([], { mapError: true }), invocationId: "code-connect-map-error-verify" });
    const mapError = await mapErrorClient.codeConnectVerify({ file: FILE_URL, outputDir, planPath: plan.planFile.path });
    assert.equal(mapError.ok, false);
    assert.equal(mapError.mappings[0].status, "unavailable");
    assert.ok(mapError.outputFiles?.upstreamFile?.path);
    const mapSidecar = await readFile(mapError.outputFiles.upstreamFile.path, "utf8");
    assert.doesNotMatch(mapSidecar, /map-must-not-leak|_meta/u);
    assert.doesNotMatch(JSON.stringify(mapError), /map-must-not-leak|_meta/u);
    await mapErrorClient.close();
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("unreadable get_code_connect_map blocks plan artifact creation and reports verify unavailable", async () => {
  const outputDir = await mkdtemp(resolve(tmpdir(), "figma-code-connect-unavailable-"));
  const planCalls = [];
  const planClient = createFigmaWorkspaceClient({ client: fakeUpstream(planCalls, { unreadableMap: true }), invocationId: "code-connect-unreadable-plan" });
  try {
    const blocked = await planClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "blocked.json"), manifest: manifest() });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.mappings[0].status, "unavailable");
    assert.equal("planFile" in blocked, false);
    await assert.rejects(readFile(resolve(outputDir, "blocked.json")), /ENOENT/iu);
  } finally {
    await planClient.close();
  }

  const validCalls = [];
  const validClient = createFigmaWorkspaceClient({ client: fakeUpstream(validCalls), invocationId: "code-connect-valid-plan" });
  try {
    const plan = await validClient.codeConnectPlan({ file: FILE_URL, outputDir, outputPlanPath: resolve(outputDir, "valid.json"), manifest: manifest() });
    const verifyCalls = [];
    const verifyClient = createFigmaWorkspaceClient({ client: fakeUpstream(verifyCalls, { unreadableMap: true }), invocationId: "code-connect-unavailable-verify" });
    try {
      const unavailable = await verifyClient.codeConnectVerify({ file: FILE_URL, outputDir, planPath: plan.planFile.path });
      assert.equal(unavailable.ok, false);
      assert.equal(unavailable.mappings[0].status, "unavailable");
      assert.equal(verifyCalls.filter((entry) => entry.kind === "call" && entry.name === "get_code_connect_map").length, 1);
    } finally {
      await verifyClient.close();
    }
  } finally {
    await validClient.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
