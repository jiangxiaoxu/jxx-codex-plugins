/**
 * Stateless Figma Workspace CLI 对外暴露的 public command namespace.
 *
 * 此列表只包含 public leaf command. family help alias (例如
 * `figma:docs:help`) 不属于此 registry.
 */
export const FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS = [
  "figma:api:read",
  "figma:api:search",
  "figma:assets:apply",
  "figma:assets:download",
  "figma:capture",
  "figma:code-connect:apply",
  "figma:code-connect:inspect",
  "figma:code-connect:plan",
  "figma:code-connect:verify",
  "figma:design-context",
  "figma:design-system",
  "figma:docs:catalog",
  "figma:docs:list",
  "figma:docs:read",
  "figma:docs:search",
  "figma:doctor",
  "figma:inspect",
  "figma:libraries",
  "figma:metadata",
  "figma:motion-context",
  "figma:run",
  "figma:upstream:call",
  "figma:upstream:list",
  "figma:upstream:read",
  "figma:variables",
] as const;

export type FigmaWorkspacePublicCommandId = (typeof FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS)[number];

const FIGMA_WORKSPACE_PUBLIC_COMMAND_ID_SET: ReadonlySet<string> = new Set(
  FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS,
);

export function isFigmaWorkspacePublicCommandId(value: string): value is FigmaWorkspacePublicCommandId {
  return FIGMA_WORKSPACE_PUBLIC_COMMAND_ID_SET.has(value);
}

type UnprefixedPublicCommandId<T extends string> = T extends `figma:${infer Name}` ? Name : never;

/** 不带 `figma:` transport prefix 的 public leaf command name. */
export type FigmaPublicCommandName = UnprefixedPublicCommandId<FigmaWorkspacePublicCommandId>;

/**
 * 由 `src/contract/json-command-contracts.ts` 所有的 JSON contract.
 *
 * 有意使用小型 literal union, 而不从 contract module import, 以保持
 * public command registry 为纯数据 module, 避免与 parser 或 validation code
 * 形成依赖环.
 */
export type FigmaPublicCommandJsonContractName =
  | "design-system"
  | "assets:apply"
  | "code-connect:plan"
  | "upstream:call";

/**
 * 一个 command (或一个 mode profile) 的 canonical token name.
 *
 * 可序列化 registry data 使用 array. 需要 scanner allowlist 的调用方应使用
 * `getFigmaPublicCommandTokenSets`; 该 helper 每次返回新的 `Set`, 不会修改
 * registry.
 */
export interface FigmaPublicCommandTokenNames {
  readonly options: readonly string[];
  readonly flags: readonly string[];
  readonly repeats: readonly string[];
}

/** 为 parser materialize 的独立 Set token allowlist. */
export interface FigmaPublicCommandTokenSets {
  readonly options: Set<string>;
  readonly flags: Set<string>;
  readonly repeats: Set<string>;
}

/** Mode-specific token profile. */
export type FigmaPublicCommandProfile = FigmaPublicCommandTokenNames;

/**
 * Typed public leaf specification.
 *
 * `name` 保持 unprefixed (`metadata`, `code-connect:plan`, ...), `id` 则为
 * 对应的 public command id (`figma:metadata`, ...).
 */
export interface FigmaPublicCommandSpec<Name extends FigmaPublicCommandName = FigmaPublicCommandName>
  extends FigmaPublicCommandTokenNames {
  readonly name: Name;
  readonly id: FigmaWorkspacePublicCommandId;
  readonly profiles?: Readonly<Record<string, FigmaPublicCommandProfile>>;
  readonly jsonContract?: FigmaPublicCommandJsonContractName;
  /** Complete argv prefix for the command's parser-ready JSON example. */
  readonly jsonExampleArgv?: readonly string[];
}

type FigmaPublicCommandSpecDefinition = FigmaPublicCommandTokenNames & {
  readonly profiles?: Readonly<Record<string, FigmaPublicCommandProfile>>;
  readonly jsonContract?: FigmaPublicCommandJsonContractName;
  readonly jsonExampleArgv?: readonly string[];
};

const READ_FLAGS = ["refresh", "force-code", "no-code-connect", "exclude-screenshot", "recursive"] as const;
const TARGET_OPTIONS = ["file", "node", "target", "surface", "output-dir", "max-inline-bytes"] as const;
const CONTEXT_OPTIONS = [
  ...TARGET_OPTIONS.slice(0, -1),
  "mode",
  "depth",
  "client-languages",
  "client-frameworks",
  TARGET_OPTIONS[TARGET_OPTIONS.length - 1],
] as const;
const INSPECT_OPTIONS = [
  ...TARGET_OPTIONS.slice(0, -1),
  "mode",
  "depth",
  "cursor",
  "fields",
  TARGET_OPTIONS[TARGET_OPTIONS.length - 1],
] as const;

/**
 * Public parser token declaration 的 single source of truth.
 *
 * Mapped type 确保新增 public id 时必须同时添加对应 specification, 否则
 * 在编译期失败. 保持每个 command 的 set 显式声明; 扩大为 shared union 会
 * 静默改变 unknown option behavior.
 */
const FIGMA_PUBLIC_COMMAND_SPEC_DEFINITIONS: {
  readonly [Name in FigmaPublicCommandName]: FigmaPublicCommandSpecDefinition;
} = {
  "api:read": {
    options: ["format"],
    flags: [],
    repeats: [],
  },
  "api:search": {
    options: ["limit", "snippet-lines", "format"],
    flags: [],
    repeats: [],
  },
  "assets:apply": {
    options: ["input", "file", "surface", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
    jsonContract: "assets:apply",
    jsonExampleArgv: ["--input", "-"],
  },
  "assets:download": {
    options: [
      "file",
      "node",
      "target",
      "surface",
      "default-format",
      "default-scale",
      "output-dir",
      "max-inline-bytes",
    ],
    flags: [],
    repeats: [],
  },
  capture: {
    options: [
      "file",
      "node",
      "target",
      "surface",
      "image-file",
      "output-dir",
      "max-dimension",
      "max-inline-bytes",
    ],
    flags: ["contents-only"],
    repeats: [],
  },
  "code-connect:apply": {
    options: ["file", "surface", "plan", "confirm-plan", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
  },
  "code-connect:inspect": {
    options: ["file", "surface", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
  },
  "code-connect:plan": {
    options: ["file", "surface", "input", "output-plan", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
    jsonContract: "code-connect:plan",
    jsonExampleArgv: ["--input", "-", "--file", "$EXAMPLE_FILE_URL"],
  },
  "code-connect:verify": {
    options: ["file", "surface", "plan", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
  },
  "design-context": {
    options: CONTEXT_OPTIONS,
    flags: READ_FLAGS,
    repeats: [],
  },
  "design-system": {
    options: ["input", "file", "surface", "output-dir", "max-inline-bytes"],
    flags: ["no-code-connect", "refresh"],
    repeats: ["library"],
    jsonContract: "design-system",
    jsonExampleArgv: ["--input", "-"],
  },
  "docs:catalog": {
    options: ["task-family", "surface", "classification", "limit"],
    flags: [],
    repeats: [],
  },
  "docs:list": {
    options: [],
    flags: [],
    repeats: [],
  },
  "docs:read": {
    options: [],
    flags: [],
    repeats: [],
  },
  "docs:search": {
    options: ["scope", "surface", "task-family", "limit", "snippet-lines"],
    flags: [],
    repeats: [],
  },
  doctor: {
    options: [],
    flags: [],
    repeats: [],
  },
  inspect: {
    options: INSPECT_OPTIONS,
    flags: READ_FLAGS,
    repeats: [],
    // 两种 mode 共用 lexical allowlist. `tool-args.ts` 在扫描后报告
    // cursor/fields 的 mode-specific 限制, 保持 style mode 的既有错误.
    profiles: {
      inspect: {
        options: INSPECT_OPTIONS,
        flags: READ_FLAGS,
        repeats: [],
      },
      style: {
        options: INSPECT_OPTIONS,
        flags: READ_FLAGS,
        repeats: [],
      },
    },
  },
  libraries: {
    options: ["file", "surface", "output-dir", "offset", "max-inline-bytes"],
    flags: ["refresh"],
    repeats: [],
  },
  metadata: {
    options: ["file", "node", "target", "surface", "output-dir", "mode", "depth", "max-inline-bytes"],
    flags: READ_FLAGS,
    repeats: [],
  },
  "motion-context": {
    options: CONTEXT_OPTIONS,
    flags: READ_FLAGS,
    repeats: [],
  },
  run: {
    options: ["file", "surface", "script", "source", "target-page", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
  },
  "upstream:call": {
    options: ["input", "file", "surface", "output-dir", "max-inline-bytes"],
    flags: [],
    repeats: [],
    jsonContract: "upstream:call",
    jsonExampleArgv: ["--input", "-"],
  },
  "upstream:list": {
    options: [],
    flags: ["refresh"],
    repeats: [],
  },
  "upstream:read": {
    options: [],
    flags: ["refresh"],
    repeats: [],
  },
  variables: {
    options: CONTEXT_OPTIONS,
    flags: READ_FLAGS,
    repeats: [],
  },
};

function freezeTokenNames(value: FigmaPublicCommandTokenNames): FigmaPublicCommandTokenNames {
  return Object.freeze({
    options: Object.freeze([...value.options]),
    flags: Object.freeze([...value.flags]),
    repeats: Object.freeze([...value.repeats]),
  });
}

function freezeSpec(
  name: FigmaPublicCommandName,
  id: FigmaWorkspacePublicCommandId,
  definition: FigmaPublicCommandSpecDefinition,
): FigmaPublicCommandSpec {
  const tokenNames = freezeTokenNames(definition);
  const profiles = definition.profiles === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(
      Object.entries(definition.profiles).map(([profileName, profile]) => [profileName, freezeTokenNames(profile)]),
    ) as Record<string, FigmaPublicCommandProfile>);
  return Object.freeze({
    name,
    id,
    ...tokenNames,
    ...(profiles === undefined ? {} : { profiles }),
    ...(definition.jsonContract === undefined ? {} : { jsonContract: definition.jsonContract }),
    ...(definition.jsonExampleArgv === undefined ? {} : { jsonExampleArgv: Object.freeze([...definition.jsonExampleArgv]) }),
  });
}

const specsByName: Record<string, FigmaPublicCommandSpec> = Object.create(null) as Record<string, FigmaPublicCommandSpec>;
const specs = FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS.map((id) => {
  const name = id.slice("figma:".length) as FigmaPublicCommandName;
  const definition = FIGMA_PUBLIC_COMMAND_SPEC_DEFINITIONS[name];
  if (definition === undefined) {
    // This is defensive for runtime JavaScript consumers; the mapped type
    // above already enforces the same invariant at compile time.
    throw new Error(`Missing public command specification for ${id}.`);
  }
  const spec = freezeSpec(name, id, definition);
  specsByName[name] = spec;
  return spec;
});

/**
 * 有序且 immutable 的 public leaf specification. 顺序遵循
 * `FIGMA_WORKSPACE_PUBLIC_COMMAND_IDS`, 确保 registry 与 help output 在各次
 * build 间保持稳定.
 */
export const FIGMA_PUBLIC_COMMAND_SPECS: readonly FigmaPublicCommandSpec[] = Object.freeze(specs);

const FIGMA_PUBLIC_COMMAND_SPEC_BY_NAME: Readonly<Record<string, FigmaPublicCommandSpec>> = Object.freeze(specsByName);

function normalizePublicCommandName(value: string): FigmaPublicCommandName | undefined {
  const candidate = value.startsWith("figma:") ? value.slice("figma:".length) : value;
  return Object.prototype.hasOwnProperty.call(FIGMA_PUBLIC_COMMAND_SPEC_BY_NAME, candidate)
    ? candidate as FigmaPublicCommandName
    : undefined;
}

/** 返回 unprefixed (或 prefixed) name 对应的 immutable specification. */
export function getFigmaPublicCommandSpec(value: string): FigmaPublicCommandSpec | undefined {
  const name = normalizePublicCommandName(value);
  return name === undefined ? undefined : FIGMA_PUBLIC_COMMAND_SPEC_BY_NAME[name];
}

/** 按 registry 顺序返回全部 immutable public leaf specification. */
export function getFigmaPublicCommandSpecs(): readonly FigmaPublicCommandSpec[] {
  return FIGMA_PUBLIC_COMMAND_SPECS;
}

/**
 * 为 command 或其 profile materialize parser token allowlist.
 * 每次调用都创建独立 Set; 修改返回的 Set 不会影响 central registry 或其他
 * parser invocation.
 */
export function getFigmaPublicCommandTokenSets(
  value: string,
  profile?: string,
): FigmaPublicCommandTokenSets | undefined {
  const spec = getFigmaPublicCommandSpec(value);
  if (spec === undefined) return undefined;
  const tokenNames = profile === undefined || profile === "default"
    ? spec
    : spec.profiles?.[profile];
  if (tokenNames === undefined) return undefined;
  return {
    options: new Set(tokenNames.options),
    flags: new Set(tokenNames.flags),
    repeats: new Set(tokenNames.repeats),
  };
}
