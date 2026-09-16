import { FIGMA_WORKSPACE_IMAGE_SCALE_MODE_PATTERN, INLINE_RESULT_LIMIT_MAX, INLINE_RESULT_LIMIT_MIN, MAX_MANIFEST_ITEMS } from "./json-command-primitives.js";
import { COMPOSITE_CAPABLE_NODE_ID_PATTERN, FIGMA_FILE_KEY_PATTERN, SIMPLE_NODE_ID_PATTERN } from "./figma-target.js";
import {
  getFigmaPublicCommandSpecs,
  type FigmaPublicCommandSpec,
} from "../runtime/public-command-registry.js";

/** A JSON Schema fragment used by the public Figma Workspace descriptions. */
export type JsonSchema = Record<string, unknown>;

export type FigmaJsonCommandName =
  | "design-system"
  | "assets:apply"
  | "code-connect:plan"
  | "upstream:call";

export interface FigmaJsonCommandContract {
  /** The schema for the JSON document supplied to the command's --input option. */
  inputSchema: JsonSchema;
  /** A complete, parser-ready document. It intentionally uses a real-looking key and node id. */
  example: Record<string, unknown>;
  /** Additional complete examples for contracts with more than one useful target form. */
  examples?: readonly Record<string, unknown>[];
  /** Short notes shown after the schema in leaf help. */
  notes: readonly string[];
}

export const schemaString = (description: string, minLength?: number): JsonSchema => ({
  type: "string",
  ...(minLength === undefined ? {} : { minLength }),
  description,
});

export const schemaFileKey = (description: string): JsonSchema => ({
  type: "string",
  pattern: FIGMA_FILE_KEY_PATTERN,
  description,
});

export const schemaNodeId = (description: string, allowComposite = false): JsonSchema => ({
  type: "string",
  pattern: allowComposite ? COMPOSITE_CAPABLE_NODE_ID_PATTERN : SIMPLE_NODE_ID_PATTERN,
  description,
});

export const schemaBoolean = (description: string): JsonSchema => ({ type: "boolean", description });

export const schemaInteger = (description: string, minimum = 0, maximum?: number): JsonSchema => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
  description,
});

export const schemaClampedInteger = (description: string, minimum: number, maximum: number): JsonSchema => ({
  type: "integer",
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
  description: `${description} Safe integers are accepted. Supported range ${minimum}..${maximum}; out-of-range safe integers are clamped and reported in parameterAdjustments.`,
});

export const schemaSurface = (): JsonSchema => ({
  type: "string",
  enum: ["design", "figjam", "slides"],
  description: "Explicit surface. Required with a raw file key for Plugin API execution.",
});

export const schemaDesignSurface = (): JsonSchema => ({
  type: "string",
  enum: ["design"],
  description: "Design surface only. Required with a raw file key or structured target for metadata.",
});

export const schemaFigmaFileReference = (description: string): JsonSchema => ({
  oneOf: [
    schemaFileKey("Raw Figma file key."),
    {
      type: "string",
      format: "uri",
      pattern: "^https://(?:[^/]+\\.)*figma\\.com/(?:design|file|figjam|board|slides)/",
      description: "Figma file URL.",
    },
  ],
  description,
});

export const schemaDesignFileReference = (description: string): JsonSchema => ({
  oneOf: [
    schemaFileKey("Raw Design file key."),
    {
      type: "string",
      format: "uri",
      pattern: "^https://(?:[^/]+\\.)*figma\\.com/(?:design|file)/",
      description: "Design file URL.",
    },
  ],
  description,
});

function schemaNodeUrlPattern(): string {
  return "^https://(?:[^/]+\\.)*figma\\.com/(?:design|file|figjam|board|slides)/[^?#]+\\?(?:[^#]*&)?(?:node-id|node_id)=[^&#]+";
}

function schemaDesignNodeUrlPattern(): string {
  return "^https://(?:[^/]+\\.)*figma\\.com/(?:design|file)/[^?#]+\\?(?:[^#]*&)?(?:node-id|node_id)=[^&#]+";
}

export const schemaNodeTarget = (allowComposite = false): JsonSchema => ({
  description: "Stable node target: raw node id (with file), Figma node URL, or exact { fileKey, nodeId }.",
  oneOf: [
    schemaNodeId("Raw Figma node id.", allowComposite),
    {
      type: "string",
      format: "uri",
      pattern: schemaNodeUrlPattern(),
      description: "Figma node URL with a node-id query parameter.",
    },
    {
      type: "object",
      properties: {
        fileKey: schemaFileKey("Figma file key."),
        nodeId: schemaNodeId("Figma node id.", allowComposite),
      },
      required: ["fileKey", "nodeId"],
      additionalProperties: false,
    },
  ],
});

export const schemaDesignNodeTarget = (): JsonSchema => ({
  description: "Design-only stable node target: Design node URL, raw node id paired with a Design file, or exact { fileKey, nodeId } with surface design.",
  oneOf: [
    schemaNodeId("Raw Figma node id.", true),
    {
      type: "string",
      format: "uri",
      pattern: schemaDesignNodeUrlPattern(),
      description: "Design node URL with a node-id query parameter.",
    },
    {
      type: "object",
      properties: {
        fileKey: schemaFileKey("Design file key."),
        nodeId: schemaNodeId("Figma node id.", true),
      },
      required: ["fileKey", "nodeId"],
      additionalProperties: false,
    },
  ],
});

export const schemaInvocation = (): Record<string, JsonSchema> => ({
  title: schemaString("Optional display label."),
  file: schemaFigmaFileReference("Figma file URL or raw file key."),
  surface: schemaSurface(),
  outputDir: schemaString("Optional local output root; relative paths resolve from invocation cwd. Omitted outputs use one invocation temp directory."),
  inlineResultLimit: schemaInteger(`Maximum inline result bytes from ${INLINE_RESULT_LIMIT_MIN} to ${INLINE_RESULT_LIMIT_MAX}.`, INLINE_RESULT_LIMIT_MIN, INLINE_RESULT_LIMIT_MAX),
});

export const schemaDesignSystemQueries = (): JsonSchema => ({
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      entity: { type: "string", enum: ["component", "variable", "style"], description: "Design-system asset entity." },
      query: schemaString("One search intent for this entity.", 1),
    },
    required: ["entity", "query"],
    additionalProperties: false,
  },
  description: "Ordered design-system search intents; each item is dispatched in one batch request.",
});

export const schemaAssetManifestAsset = (): JsonSchema => ({
  type: "object",
  properties: {
    path: schemaString("PNG, JPG/JPEG, GIF, or WebP raster path. Relative paths use the JSON input file's directory, or invocation cwd for stdin."),
    target: schemaNodeTarget(),
    nodeUrl: schemaString("Optional node URL retained in the asset result."),
    url: schemaString("Optional node URL alias retained in the asset result."),
    scaleMode: { type: "string", pattern: FIGMA_WORKSPACE_IMAGE_SCALE_MODE_PATTERN, description: "Optional image scale mode: FILL, FIT, CROP, or TILE (case-insensitive; no surrounding whitespace)." },
    name: schemaString("Optional asset label."),
    metadata: { type: "object", additionalProperties: true, description: "Optional JSON metadata copied to the asset result." },
  },
  // Both fields are required for an executable upload entry. The runtime
  // validator still owns the exact failure wording and path handling.
  required: ["path", "target"],
  additionalProperties: false,
  description: "Asset entry. path and target are required.",
});

export const schemaCodeConnectManifest = (): JsonSchema => ({
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: 1, description: "Code Connect manifest schema version." },
    scope: {
      type: "object",
      properties: { nodeId: schemaNodeId("Root component node id.") },
      required: ["nodeId"],
      additionalProperties: false,
    },
    client: {
      type: "object",
      properties: {
        languages: schemaString("Optional client language list.", 1),
        frameworks: schemaString("Optional client framework list.", 1),
      },
      additionalProperties: false,
    },
    mappings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MANIFEST_ITEMS,
      items: {
        type: "object",
        properties: {
          nodeId: schemaNodeId("Component node id."),
          componentName: schemaString("Source component name.", 1),
          source: schemaString("Source file or module reference.", 1),
          label: schemaString("Live Code Connect mapping label.", 1),
          conflictPolicy: { type: "string", enum: ["fail", "replace"], description: "Conflict handling for this mapping." },
        },
        required: ["nodeId", "componentName", "source", "label"],
        additionalProperties: false,
      },
      description: `One to ${MAX_MANIFEST_ITEMS} simple Code Connect mappings.`,
    },
  },
  required: ["schemaVersion", "scope", "mappings"],
  additionalProperties: false,
  description: "Simple Code Connect mapping manifest. Template fields are unsupported.",
});

export const schemaObject = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  anyOf?: readonly JsonSchema[],
  oneOf?: readonly JsonSchema[],
): JsonSchema => ({
  type: "object",
  properties,
  required: [...required],
  ...(anyOf ? { anyOf } : {}),
  ...(oneOf ? { oneOf } : {}),
  additionalProperties: false,
});

/**
 * Internal/direct API envelope for the Code Connect plan wrapper. The public
 * `--input` contract is the manifest itself; this envelope deliberately
 * reuses that same manifest schema instead of restating its nested fields.
 */
export const schemaCodeConnectPlanArguments = (): JsonSchema => schemaObject({
  ...schemaInvocation(),
  manifest: schemaCodeConnectManifest(),
  outputPlanPath: schemaString("Optional plan artifact path inside outputDir."),
}, ["manifest"]);

const EXAMPLE_FILE_KEY = "AbCdEfGhIjKlMnOpQrStUv";
const EXAMPLE_FILE_URL = `https://www.figma.com/design/${EXAMPLE_FILE_KEY}/Tutorial`;
const EXAMPLE_NODE_URL = `${EXAMPLE_FILE_URL}?node-id=1-2`;

const JSON_COMMAND_CONTRACTS: Record<FigmaJsonCommandName, FigmaJsonCommandContract> = {
  "design-system": {
    inputSchema: schemaObject({
      ...schemaInvocation(),
      queries: schemaDesignSystemQueries(),
      disableCodeConnect: schemaBoolean("Disable Code Connect suggestions."),
      includeLibraryKeys: { type: "array", items: schemaString("Figma library key."), description: "Optional library keys to include." },
      refresh: schemaBoolean("Refresh upstream discovery."),
    }, ["queries"]),
    example: {
      file: EXAMPLE_FILE_URL,
      queries: [{ entity: "component", query: "button" }],
    },
    notes: [
      "file, surface, and outputDir may be supplied in JSON or with their corresponding CLI options; conflicting values fail closed. title is JSON-only, and --max-inline-bytes overrides JSON inlineResultLimit.",
      "The command still requires a file; provide it in JSON or with --file. A raw key also requires --surface.",
      "The input document is strict: unknown top-level fields and unknown query-item fields are rejected.",
    ],
  },
  "assets:apply": {
    inputSchema: schemaObject({
      ...schemaInvocation(),
      assets: { type: "array", minItems: 1, maxItems: MAX_MANIFEST_ITEMS, items: schemaAssetManifestAsset(), description: `One to ${MAX_MANIFEST_ITEMS} raster asset entries.` },
      validateTargets: schemaBoolean("Validate target fills after upload."),
    }, ["assets"]),
    example: {
      file: EXAMPLE_FILE_URL,
      assets: [{ path: "assets/tutorial.png", target: EXAMPLE_NODE_URL }],
    },
    examples: [
      { file: EXAMPLE_FILE_URL, assets: [{ path: "assets/tutorial.png", target: EXAMPLE_NODE_URL, scaleMode: "FIT" }] },
    ],
    notes: [
      "file, surface, and outputDir may be supplied in JSON or with their corresponding CLI options; conflicting values fail closed. title is JSON-only, and --max-inline-bytes overrides JSON inlineResultLimit.",
      "The command still requires a file; provide it in JSON or with --file. A raw key also requires --surface.",
      "The assets array is required. SVG is rejected by the raster-fill upload contract.",
      "When --input names a JSON file, each relative assets[].path is resolved from that file's directory. With --input -, relative paths use the invocation cwd. Absolute paths are preserved.",
    ],
  },
  "code-connect:plan": {
    inputSchema: schemaCodeConnectManifest(),
    example: {
      schemaVersion: 1,
      scope: { nodeId: "1:2" },
      mappings: [{ nodeId: "3:4", componentName: "TutorialPopup", source: "ui/TutorialPopup.tsx", label: "React" }],
    },
    notes: [
      "Pass the Design file with --file <Design-url|key>; a raw key requires --surface design.",
      "The --input document is the manifest itself. Templates and extra fields are rejected by the existing manifest validator.",
    ],
  },
  "upstream:call": {
    inputSchema: schemaObject({
      ...schemaInvocation(),
      toolName: schemaString("Exact official Figma MCP tool name.", 1),
      arguments: { type: "object", additionalProperties: true, description: "Arguments for toolName. Read figma:upstream:read first; this object follows the live upstream schema and is intentionally not fixed locally." },
      refresh: schemaBoolean("Refresh upstream discovery before dispatch."),
    }, ["toolName"]),
    example: {
      toolName: "get_metadata",
      arguments: { fileKey: EXAMPLE_FILE_KEY },
    },
    notes: [
      "Read figma:upstream:read <name> before calling; arguments follows that live schema and is not guessed here.",
      "file, surface, and outputDir may be supplied in JSON or through CLI options; title is JSON-only and --max-inline-bytes overrides JSON inlineResultLimit. The selected live tool still owns arguments validation.",
    ],
  },
};

export function getFigmaJsonCommandContract(command: string): FigmaJsonCommandContract | undefined {
  return (command in JSON_COMMAND_CONTRACTS)
    ? JSON_COMMAND_CONTRACTS[command as FigmaJsonCommandName]
    : undefined;
}

export function getFigmaJsonCommandContracts(): Readonly<Record<FigmaJsonCommandName, FigmaJsonCommandContract>> {
  return JSON_COMMAND_CONTRACTS;
}

/**
 * Derive the public JSON leaf set from the parser registry and assert that its
 * markers, contracts, and parser-ready examples stay in lockstep. This gate
 * is intentionally parameterized so tests can prove missing-marker,
 * missing-schema, and missing-example failures without mutating production
 * registries.
 */
export function assertFigmaJsonCommandRegistryConsistency(
  specs: readonly FigmaPublicCommandSpec[] = getFigmaPublicCommandSpecs(),
  contracts: Readonly<Record<string, FigmaJsonCommandContract>> = JSON_COMMAND_CONTRACTS,
): void {
  const inputSpecs = specs.filter(specAcceptsJsonInput);
  const markedSpecs = specs.filter((spec) => spec.jsonContract !== undefined);
  const issues: string[] = [];
  const inputNames = new Set(inputSpecs.map((spec) => spec.name));
  const markedNames = new Set(markedSpecs.map((spec) => spec.name));

  for (const spec of inputSpecs) {
    if (spec.jsonContract === undefined) {
      issues.push(`${spec.name} accepts --input but has no jsonContract marker.`);
      continue;
    }
    const contract = contracts[spec.jsonContract];
    if (!contract) {
      issues.push(`${spec.name} points to missing JSON contract ${spec.jsonContract}.`);
      continue;
    }
    if (!isRecord(contract.inputSchema)) issues.push(`${spec.name} JSON contract must expose an inputSchema.`);
    if (!isRecord(contract.example)) issues.push(`${spec.name} JSON contract must expose an example object.`);
    const argv = spec.jsonExampleArgv;
    if (!Array.isArray(argv) || !argv.includes("--input")) {
      issues.push(`${spec.name} JSON contract must expose a complete jsonExampleArgv containing --input.`);
    }
  }

  for (const spec of markedSpecs) {
    if (!inputNames.has(spec.name)) issues.push(`${spec.name} has a jsonContract marker but its parser spec does not accept --input.`);
    if (!contracts[spec.jsonContract!]) issues.push(`${spec.name} marker ${spec.jsonContract} has no matching contract.`);
  }

  for (const command of Object.keys(contracts)) {
    const spec = specs.find((candidate) => candidate.jsonContract === command);
    if (!spec) issues.push(`JSON contract ${command} has no matching registry marker.`);
  }

  if (issues.length > 0) throw new Error(`Figma JSON command registry consistency failed:\n- ${issues.join("\n- ")}`);
}

/** Return JSON leaves derived from actual parser token declarations. */
export function getFigmaJsonInputCommandNames(
  specs: readonly FigmaPublicCommandSpec[] = getFigmaPublicCommandSpecs(),
): readonly string[] {
  return specs.filter(specAcceptsJsonInput).map((spec) => spec.name);
}

function specAcceptsJsonInput(spec: FigmaPublicCommandSpec): boolean {
  if (spec.options.includes("input")) return true;
  return Object.values(spec.profiles ?? {}).some((profile) => profile.options.includes("input"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const FIGMA_JSON_COMMAND_EXAMPLE_FILE_KEY = EXAMPLE_FILE_KEY;
export const FIGMA_JSON_COMMAND_EXAMPLE_FILE_URL = EXAMPLE_FILE_URL;
export const FIGMA_JSON_COMMAND_EXAMPLE_NODE_URL = EXAMPLE_NODE_URL;
