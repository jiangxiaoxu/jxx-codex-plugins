import {
  DEFAULT_FIGMA_WORKSPACE_INSPECT_FIELDS,
  FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS,
  type FigmaWorkspaceInspectField,
} from "../contract/tool-args.js";

export const FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES = 18_000;
export const FIGMA_WORKSPACE_INSPECT_PAGE_UPSTREAM_RESERVE_BYTES = 2_000;

const INSPECT_CURSOR_VERSION = 1;
const DEFAULT_INSPECT_DEPTH = 2;
const INSPECT_CURSOR_MAX_CHARS = 4_096;
const INSPECT_NODE_TOO_LARGE = "FIGMA_WORKSPACE_INSPECT_NODE_TOO_LARGE";
const INSPECT_CURSOR_OUT_OF_RANGE = "FIGMA_WORKSPACE_INSPECT_CURSOR_OUT_OF_RANGE";
const INSPECT_PAGE_RESULT_INVALID = "FIGMA_WORKSPACE_INSPECT_PAGE_RESULT_INVALID";

export interface FigmaWorkspaceInspectPagination {
  fileKey: string;
  nodeId: string;
  depth: number;
  fields: FigmaWorkspaceInspectField[];
  offset: number;
}

export interface FigmaWorkspaceInspectPaginationOptions {
  fileKey: string;
  nodeId: string;
  depth?: number;
  fields?: readonly FigmaWorkspaceInspectField[];
  cursor?: string;
}

export interface FigmaWorkspaceInspectPageNode {
  [key: string]: unknown;
  id: string;
  type: string;
  parentId: string | null;
  depth: number;
  childCount: number;
}

export interface FigmaWorkspaceInspectPageSuccess {
  ok: true;
  target: string;
  mode: "inspect";
  readConsistency: "live";
  depth: number;
  fields: FigmaWorkspaceInspectField[];
  offset: number;
  nodes: FigmaWorkspaceInspectPageNode[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface FigmaWorkspaceInspectPageFailure {
  ok: false;
  target: string;
  mode: "inspect";
  readConsistency: "live";
  depth: number;
  fields: FigmaWorkspaceInspectField[];
  offset: number;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  suggestion?: string;
}

export type FigmaWorkspaceInspectPageResult = FigmaWorkspaceInspectPageSuccess | FigmaWorkspaceInspectPageFailure;

export class FigmaWorkspaceInspectPaginationError extends Error {
  readonly code = "FIGMA_WORKSPACE_INSPECT_CURSOR_INVALID";
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "FigmaWorkspaceInspectPaginationError";
    this.details = details;
  }
}

interface InspectCursorPayload {
  v: number;
  fileKey: string;
  nodeId: string;
  depth: number;
  fields: FigmaWorkspaceInspectField[];
  offset: number;
}

export function resolveInspectPagination(
  options: FigmaWorkspaceInspectPaginationOptions,
): FigmaWorkspaceInspectPagination {
  if (!options.fileKey || !options.nodeId) {
    throw new FigmaWorkspaceInspectPaginationError("An inspect page requires a resolved file key and node id.");
  }
  const requestedDepth = options.depth;
  if (requestedDepth !== undefined && !isNonNegativeSafeInteger(requestedDepth)) {
    throw new FigmaWorkspaceInspectPaginationError("The inspect page depth must be a non-negative safe integer.");
  }
  const requestedFields = options.fields === undefined
    ? undefined
    : canonicalInspectFields(options.fields, "Inspect fields must be a non-empty, unique list of supported field names.");

  if (options.cursor === undefined) {
    return {
      fileKey: options.fileKey,
      nodeId: options.nodeId,
      depth: requestedDepth ?? DEFAULT_INSPECT_DEPTH,
      fields: requestedFields ?? [...DEFAULT_FIGMA_WORKSPACE_INSPECT_FIELDS],
      offset: 0,
    };
  }

  const cursor = decodeInspectCursor(options.cursor);
  if (cursor.fileKey !== options.fileKey || cursor.nodeId !== options.nodeId) {
    throw new FigmaWorkspaceInspectPaginationError(
      "The inspect cursor does not match the explicit Figma file and node target.",
      { expectedFileKey: options.fileKey, expectedNodeId: options.nodeId },
    );
  }
  if (requestedDepth !== undefined && requestedDepth !== cursor.depth) {
    throw new FigmaWorkspaceInspectPaginationError(
      "The inspect cursor does not match the requested depth.",
      { cursorDepth: cursor.depth, requestedDepth },
    );
  }
  if (requestedFields !== undefined && !sameFields(requestedFields, cursor.fields)) {
    throw new FigmaWorkspaceInspectPaginationError(
      "The inspect cursor does not match the requested fields.",
      { cursorFields: cursor.fields, requestedFields },
    );
  }
  return {
    fileKey: options.fileKey,
    nodeId: options.nodeId,
    depth: cursor.depth,
    fields: [...cursor.fields],
    offset: cursor.offset,
  };
}

/**
 * Builds only the Plugin API body. The caller must wrap it with buildFigmaEvalScript.
 * The body measures the full success envelope that wrapper returns and leaves 2KB for
 * the surrounding use_figma transport before it returns a page.
 */
export function buildInspectPaginationCode(
  options: Pick<FigmaWorkspaceInspectPagination, "nodeId" | "depth" | "fields" | "offset">,
): string {
  return [
    `const __target = ${literal(options.nodeId)};`,
    `const __depth = ${literal(options.depth)};`,
    `const __fields = ${literal(options.fields)};`,
    `const __offset = ${literal(options.offset)};`,
    `const __budget = ${literal(FIGMA_WORKSPACE_INSPECT_PAGE_RESPONSE_BUDGET_BYTES)};`,
    "const __value = await __figmaWorkspaceResolveNode(__target, 'figma:inspect target');",
    "function __utf8Length(__value) {",
    "  let __bytes = 0;",
    "  for (let __index = 0; __index < __value.length; __index += 1) {",
    "    const __unit = __value.charCodeAt(__index);",
    "    if (__unit < 0x80) { __bytes += 1; continue; }",
    "    if (__unit < 0x800) { __bytes += 2; continue; }",
    "    if (__unit >= 0xd800 && __unit <= 0xdbff && __index + 1 < __value.length) {",
    "      const __next = __value.charCodeAt(__index + 1);",
    "      if (__next >= 0xdc00 && __next <= 0xdfff) { __bytes += 4; __index += 1; continue; }",
    "    }",
    "    __bytes += 3;",
    "  }",
    "  return __bytes;",
    "}",
    "function __page(__nodes, __hasMore, __nextOffset) {",
    "  const __result = { target: __target, mode: 'inspect', readConsistency: 'live', depth: __depth, fields: __fields, offset: __offset, nodes: __nodes, hasMore: __hasMore };",
    "  if (__hasMore) __result.nextOffset = __nextOffset;",
    "  return __result;",
    "}",
    "function __pageEnvelopeBytes(__nodes) {",
    "  const __result = __page(__nodes, true, Number.MAX_SAFE_INTEGER);",
    "  const __envelope = { ok: true, __figmaWorkspace: { invocationId: __figmaWorkspace.invocationId, captureRequests: __figmaWorkspace.captureRequests }, result: __result };",
    "  return __utf8Length(JSON.stringify(__envelope));",
    "}",
    "function __failure(__code, __message, __details, __suggestion) {",
    "  return { target: __target, mode: 'inspect', readConsistency: 'live', depth: __depth, fields: __fields, offset: __offset, error: { code: __code, message: __message, details: __details, suggestion: __suggestion } };",
    "}",
    "function __summary(__node, __parentId, __nodeDepth) {",
    "  const __children = Array.isArray(__node.children) ? __node.children : [];",
    "  const __result = { id: __node.id, type: __node.type, parentId: __parentId, depth: __nodeDepth, childCount: __children.length };",
    "  if (__fields.indexOf('name') !== -1) __result.name = __node.name;",
    "  if (__fields.indexOf('visible') !== -1 && 'visible' in __node) __result.visible = __node.visible;",
    "  if (__fields.indexOf('x') !== -1 && 'x' in __node) __result.x = __node.x;",
    "  if (__fields.indexOf('y') !== -1 && 'y' in __node) __result.y = __node.y;",
    "  if (__fields.indexOf('width') !== -1 && 'width' in __node) __result.width = __node.width;",
    "  if (__fields.indexOf('height') !== -1 && 'height' in __node) __result.height = __node.height;",
    "  if (__fields.indexOf('locked') !== -1 && 'locked' in __node) __result.locked = __node.locked;",
    "  if (__fields.indexOf('layoutMode') !== -1 && 'layoutMode' in __node) __result.layoutMode = __node.layoutMode;",
    "  if (__fields.indexOf('layoutPositioning') !== -1 && 'layoutPositioning' in __node) __result.layoutPositioning = __node.layoutPositioning;",
    "  if (__fields.indexOf('characters') !== -1 && typeof __node.characters === 'string') __result.characters = __node.characters;",
    "  return __result;",
    "}",
    "const __stack = [];",
    "const __roots = Array.isArray(__value) ? __value : [__value];",
    "for (let __index = __roots.length - 1; __index >= 0; __index -= 1) {",
    "  __stack.push({ node: __roots[__index], parentId: null, depth: 0 });",
    "}",
    "const __nodes = [];",
    "let __seen = 0;",
    "let __hasMore = false;",
    "let __nextOffset;",
    "while (__stack.length > 0) {",
    "  const __entry = __stack.pop();",
    "  const __node = __entry.node;",
    "  const __index = __seen;",
    "  __seen += 1;",
    "  if (__index >= __offset) {",
    "    const __candidate = __summary(__node, __entry.parentId, __entry.depth);",
    "    if (__pageEnvelopeBytes(__nodes.concat([__candidate])) > __budget) {",
    "      if (__nodes.length === 0) {",
    `        return __failure('${INSPECT_NODE_TOO_LARGE}', 'One selected node exceeds the inspect page response budget.', { nodeId: __candidate.id, fields: __fields, byteBudget: __budget }, 'Remove characters from --fields or select fewer fields for this node.');`,
    "      }",
    "      __hasMore = true;",
    "      __nextOffset = __offset + __nodes.length;",
    "      break;",
    "    }",
    "    __nodes.push(__candidate);",
    "  }",
    "  if (__entry.depth < __depth) {",
    "    const __children = Array.isArray(__node.children) ? __node.children : [];",
    "    for (let __childIndex = __children.length - 1; __childIndex >= 0; __childIndex -= 1) {",
    "      __stack.push({ node: __children[__childIndex], parentId: __node.id, depth: __entry.depth + 1 });",
    "    }",
    "  }",
    "}",
    "if (__nodes.length === 0 && __offset >= __seen) {",
    `  return __failure('${INSPECT_CURSOR_OUT_OF_RANGE}', 'The inspect cursor offset is outside the current live traversal.', { offset: __offset, currentNodeCount: __seen }, 'Restart inspection from the target because the tree changed between pages.');`,
    "}",
    "return __page(__nodes, __hasMore, __nextOffset);",
  ].join("\n");
}

export function finalizeInspectPaginationResult(
  value: unknown,
  page: FigmaWorkspaceInspectPagination,
): FigmaWorkspaceInspectPageResult {
  const result = asRecord(value);
  if (!result) return invalidPageResult(page, "The inspect page did not return an object.");
  const error = asRecord(result.error);
  if (error) return remotePageFailure(page, error);
  if (
    result.target !== page.nodeId
    || result.mode !== "inspect"
    || result.readConsistency !== "live"
    || result.depth !== page.depth
    || result.offset !== page.offset
    || !sameFieldsFromUnknown(result.fields, page.fields)
    || !Array.isArray(result.nodes)
    || typeof result.hasMore !== "boolean"
  ) {
    return invalidPageResult(page, "The inspect page returned an unexpected shape.");
  }
  const nodes = validatePageNodes(result.nodes);
  if (!nodes) return invalidPageResult(page, "The inspect page returned malformed node records.");
  if (nodes.length === 0) return invalidPageResult(page, "The inspect page returned no nodes without an explicit cursor-range error.");
  if (!result.hasMore) {
    return pageSuccess(page, nodes, false);
  }
  if (
    !isNonNegativeSafeInteger(result.nextOffset)
    || result.nextOffset !== page.offset + nodes.length
  ) {
    return invalidPageResult(page, "The inspect page returned an invalid continuation offset.");
  }
  return pageSuccess(page, nodes, true, encodeInspectCursor({
    v: INSPECT_CURSOR_VERSION,
    fileKey: page.fileKey,
    nodeId: page.nodeId,
    depth: page.depth,
    fields: page.fields,
    offset: result.nextOffset,
  }));
}

function decodeInspectCursor(value: string): InspectCursorPayload {
  if (typeof value !== "string" || !value || value.length > INSPECT_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new FigmaWorkspaceInspectPaginationError("The inspect cursor is malformed.");
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url");
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new FigmaWorkspaceInspectPaginationError("The inspect cursor is malformed.");
  }
  const cursor = asRecord(parsed);
  if (!cursor || !sameKeys(cursor, ["v", "fileKey", "nodeId", "depth", "fields", "offset"])) {
    throw new FigmaWorkspaceInspectPaginationError("The inspect cursor has an unsupported shape.");
  }
  if (
    cursor.v !== INSPECT_CURSOR_VERSION
    || typeof cursor.fileKey !== "string"
    || !cursor.fileKey
    || typeof cursor.nodeId !== "string"
    || !cursor.nodeId
    || !isNonNegativeSafeInteger(cursor.depth)
    || !isNonNegativeSafeInteger(cursor.offset)
  ) {
    throw new FigmaWorkspaceInspectPaginationError("The inspect cursor has invalid values.");
  }
  const fields = canonicalInspectFields(cursor.fields, "The inspect cursor has invalid fields.");
  if (!sameFieldsFromUnknown(cursor.fields, fields)) {
    throw new FigmaWorkspaceInspectPaginationError("The inspect cursor fields are not canonical.");
  }
  return {
    v: INSPECT_CURSOR_VERSION,
    fileKey: cursor.fileKey,
    nodeId: cursor.nodeId,
    depth: cursor.depth,
    fields,
    offset: cursor.offset,
  };
}

function encodeInspectCursor(value: InspectCursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function canonicalInspectFields(value: unknown, message: string): FigmaWorkspaceInspectField[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((field) => typeof field !== "string")) {
    throw new FigmaWorkspaceInspectPaginationError(message);
  }
  const fields = value as string[];
  if (new Set(fields).size !== fields.length || fields.some((field) => !(FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS as readonly string[]).includes(field))) {
    throw new FigmaWorkspaceInspectPaginationError(message);
  }
  const selected = new Set(fields);
  return FIGMA_WORKSPACE_INSPECT_DETAIL_FIELDS.filter((field) => selected.has(field));
}

function pageSuccess(
  page: FigmaWorkspaceInspectPagination,
  nodes: FigmaWorkspaceInspectPageNode[],
  hasMore: boolean,
  nextCursor?: string,
): FigmaWorkspaceInspectPageSuccess {
  return {
    ok: true,
    target: page.nodeId,
    mode: "inspect",
    readConsistency: "live",
    depth: page.depth,
    fields: [...page.fields],
    offset: page.offset,
    nodes,
    hasMore,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function remotePageFailure(
  page: FigmaWorkspaceInspectPagination,
  error: Record<string, unknown>,
): FigmaWorkspaceInspectPageFailure {
  const code = typeof error.code === "string" ? error.code : INSPECT_PAGE_RESULT_INVALID;
  const message = typeof error.message === "string" ? error.message : "The inspect page returned an invalid error.";
  const details = asRecord(error.details);
  const suggestion = typeof error.suggestion === "string" ? error.suggestion : undefined;
  return pageFailure(page, code, message, details, suggestion);
}

function invalidPageResult(
  page: FigmaWorkspaceInspectPagination,
  message: string,
): FigmaWorkspaceInspectPageFailure {
  return pageFailure(page, INSPECT_PAGE_RESULT_INVALID, message);
}

function pageFailure(
  page: FigmaWorkspaceInspectPagination,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  suggestion?: string,
): FigmaWorkspaceInspectPageFailure {
  return {
    ok: false,
    target: page.nodeId,
    mode: "inspect",
    readConsistency: "live",
    depth: page.depth,
    fields: [...page.fields],
    offset: page.offset,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function validatePageNodes(value: unknown[]): FigmaWorkspaceInspectPageNode[] | undefined {
  const nodes: FigmaWorkspaceInspectPageNode[] = [];
  for (const entry of value) {
    const node = asRecord(entry);
    if (
      !node
      || typeof node.id !== "string"
      || typeof node.type !== "string"
      || (node.parentId !== null && typeof node.parentId !== "string")
      || !isNonNegativeSafeInteger(node.depth)
      || !isNonNegativeSafeInteger(node.childCount)
    ) {
      return undefined;
    }
    nodes.push(node as FigmaWorkspaceInspectPageNode);
  }
  return nodes;
}

function sameFields(left: readonly FigmaWorkspaceInspectField[], right: readonly FigmaWorkspaceInspectField[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}

function sameFieldsFromUnknown(value: unknown, expected: readonly FigmaWorkspaceInspectField[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function literal(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Inspect pagination value must be JSON-serializable.");
  return serialized;
}
