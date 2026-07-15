import { readFileSync } from "node:fs";

export const TASK_FAMILIES = [
  "code-connect",
  "create-file",
  "design-to-code",
  "design-generation",
  "diagram",
  "library-generation",
  "motion-implementation",
  "swiftui",
  "figjam",
  "motion",
  "slides",
  "design-editing",
] as const;

export type TaskFamily = (typeof TASK_FAMILIES)[number];

export const TASK_SURFACES = ["design", "figjam", "slides"] as const;

export type TaskSurface = (typeof TASK_SURFACES)[number];

export const TASK_ROUTING_AUTO_SCOPES = ["active", "conditional", "router"] as const;

export type TaskRoutingAutoScope = (typeof TASK_ROUTING_AUTO_SCOPES)[number];
export type TaskRouteStatus = "matched" | "ambiguous" | "fallback" | "none";
export type TaskRouteConfidence = "high" | "medium" | "low" | "none";
export type TaskRouteMatchKind = "explicit" | "exact-alias" | "multi-token" | "single-token";

export interface TaskRouteDefinition {
  taskFamily: TaskFamily;
  skill: string;
  surfaces: TaskSurface[];
  canonicalQuery: string;
  aliases: string[];
}

export interface TaskRoutingCatalog {
  schemaVersion: 1;
  routes: TaskRouteDefinition[];
}

export interface ResolveTaskRouteOptions {
  query: string;
  routes: readonly TaskRouteDefinition[];
  requestedSurface?: TaskSurface;
  explicitTaskFamily?: TaskFamily;
}

export interface TaskRouteResult {
  status: TaskRouteStatus;
  confidence: TaskRouteConfidence;
  surface?: TaskSurface;
  taskFamily?: TaskFamily;
  skill?: string;
  candidateTaskFamilies: TaskFamily[];
  effectiveScopes: TaskRoutingAutoScope[];
  normalizedQuery: string;
  canonicalQuery?: string;
  matchKind?: TaskRouteMatchKind;
  matchedAlias?: string;
  reason: string;
}

interface NormalizedRoute {
  route: TaskRouteDefinition;
  phrases: NormalizedPhrase[];
}

interface NormalizedPhrase {
  value: string;
  tokens: string[];
}

const TASK_FAMILY_SET = new Set<string>(TASK_FAMILIES);
const TASK_SURFACE_SET = new Set<string>(TASK_SURFACES);
const ROUTE_KEYS = ["aliases", "canonicalQuery", "skill", "surfaces", "taskFamily"] as const;

export function normalizeTaskRoutingQuery(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function parseTaskRoutingCatalog(value: unknown): TaskRoutingCatalog {
  const catalog = requireRecord(value, "task route catalog");
  const keys = Object.keys(catalog).sort();
  if (keys.length !== 2 || keys[0] !== "routes" || keys[1] !== "schemaVersion") {
    throw new Error("Task route catalog must contain exactly: routes, schemaVersion.");
  }
  if (catalog.schemaVersion !== 1) {
    throw new Error("Task route catalog schemaVersion must be 1.");
  }
  return {
    schemaVersion: 1,
    routes: parseTaskRouteDefinitions(catalog.routes, "task route catalog routes"),
  };
}

export function parseTaskRouteDefinitions(value: unknown, context = "task route catalog"): TaskRouteDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }
  if (value.length !== TASK_FAMILIES.length) {
    throw new Error(`${context} must contain exactly ${TASK_FAMILIES.length} routes.`);
  }

  const routes = value.map((entry, index) => parseTaskRouteDefinition(entry, `${context}[${index}]`));
  const families = new Set(routes.map((route) => route.taskFamily));
  const missingFamilies = TASK_FAMILIES.filter((family) => !families.has(family));
  if (families.size !== TASK_FAMILIES.length || missingFamilies.length > 0) {
    throw new Error(`${context} must contain each stable task family exactly once. Missing: ${missingFamilies.join(", ") || "none"}.`);
  }

  for (let index = 1; index < routes.length; index += 1) {
    if (routes[index - 1].taskFamily >= routes[index].taskFamily) {
      throw new Error(`${context} must be strictly sorted by taskFamily.`);
    }
  }

  const aliasOwners = new Map<string, TaskFamily>();
  for (const route of routes) {
    for (const alias of route.aliases) {
      const normalized = normalizeTaskRoutingQuery(alias);
      const owner = aliasOwners.get(normalized);
      if (owner) {
        throw new Error(`${context} alias "${normalized}" is duplicated by ${owner} and ${route.taskFamily}.`);
      }
      aliasOwners.set(normalized, route.taskFamily);
    }
  }
  return routes;
}

export function loadTaskRoutingCatalog(file: string): TaskRoutingCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read task route catalog ${file}: ${message}`);
  }
  return parseTaskRoutingCatalog(parsed);
}

export function resolveTaskRoute(options: ResolveTaskRouteOptions): TaskRouteResult {
  if (typeof options.query !== "string") {
    throw new Error("Task routing query must be a string.");
  }
  if (options.requestedSurface !== undefined && !TASK_SURFACE_SET.has(options.requestedSurface)) {
    throw new Error(`Unknown requested task surface: ${String(options.requestedSurface)}.`);
  }
  if (options.explicitTaskFamily !== undefined && !TASK_FAMILY_SET.has(options.explicitTaskFamily)) {
    throw new Error(`Unknown explicit task family: ${String(options.explicitTaskFamily)}.`);
  }

  const normalizedQuery = normalizeTaskRoutingQuery(options.query);
  const normalizedRoutes = normalizeRoutes(options.routes);
  const compatibleRoutes = normalizedRoutes.filter(({ route }) =>
    options.requestedSurface === undefined || route.surfaces.includes(options.requestedSurface));

  if (options.explicitTaskFamily !== undefined) {
    const selected = compatibleRoutes.find(({ route }) => route.taskFamily === options.explicitTaskFamily);
    if (!selected) {
      return noRouteResult({
        normalizedQuery,
        requestedSurface: options.requestedSurface,
        reason: options.requestedSurface
          ? `Explicit task family ${options.explicitTaskFamily} is not compatible with requested surface ${options.requestedSurface}.`
          : `Explicit task family ${options.explicitTaskFamily} is not present in the route catalog.`,
        confidence: "none",
      });
    }
    return selectedRouteResult(selected.route, {
      status: "matched",
      confidence: "high",
      normalizedQuery,
      requestedSurface: options.requestedSurface,
      matchKind: "explicit",
      reason: `Explicit task family ${selected.route.taskFamily} overrides query inference.`,
    });
  }

  if (!normalizedQuery) {
    return noRouteResult({
      normalizedQuery,
      requestedSurface: options.requestedSurface,
      reason: "Query contains no normalized English routing tokens.",
      confidence: "none",
    });
  }

  const queryTokens = normalizedQuery.split(" ");
  const queryTokenSet = new Set(queryTokens);
  if (options.requestedSurface !== undefined) {
    const conflict = incompatibleSurfaceMatch(
      normalizedQuery,
      queryTokens,
      queryTokenSet,
      normalizedRoutes,
      options.requestedSurface,
    );
    if (conflict) {
      return noRouteResult({
        normalizedQuery,
        requestedSurface: options.requestedSurface,
        reason: conflict,
        confidence: "low",
      });
    }
  }

  const exactMatches = strongestExactMatches(collectExactMatches(normalizedQuery, queryTokens, compatibleRoutes));
  if (exactMatches.length > 0) {
    return resolveMatchedCandidates({
      candidates: exactMatches,
      normalizedQuery,
      requestedSurface: options.requestedSurface,
      matchKind: "exact-alias",
      confidence: "high",
      reason: "Matched the longest contiguous route alias.",
    });
  }

  const multiTokenMatches = collectMultiTokenMatches(queryTokenSet, compatibleRoutes);
  if (multiTokenMatches.length > 0) {
    return resolveMatchedCandidates({
      candidates: multiTokenMatches,
      normalizedQuery,
      requestedSurface: options.requestedSurface,
      matchKind: "multi-token",
      confidence: "medium",
      reason: "Matched a unique route using multiple English query tokens.",
    });
  }

  const singleTokenMatches = collectSingleTokenMatches(queryTokenSet, compatibleRoutes);
  if (singleTokenMatches.length > 0) {
    return resolveMatchedCandidates({
      candidates: singleTokenMatches,
      normalizedQuery,
      requestedSurface: options.requestedSurface,
      matchKind: "single-token",
      confidence: "low",
      status: "fallback",
      reason: "Only a single routing token matched; use the candidate as a low-confidence fallback.",
    });
  }

  return noRouteResult({
    normalizedQuery,
    requestedSurface: options.requestedSurface,
    reason: "No task route matched the normalized English query.",
    confidence: "low",
  });
}

function incompatibleSurfaceMatch(
  normalizedQuery: string,
  queryTokens: string[],
  queryTokenSet: ReadonlySet<string>,
  routes: readonly NormalizedRoute[],
  requestedSurface: TaskSurface,
): string | undefined {
  const exactMatches = strongestExactMatches(collectExactMatches(normalizedQuery, queryTokens, routes));
  if (exactMatches.length > 0) {
    return exactMatches.some(({ route }) => route.surfaces.includes(requestedSurface))
      ? undefined
      : `Strongest exact task route is not compatible with requested surface ${requestedSurface}.`;
  }
  const multiTokenMatches = collectMultiTokenMatches(queryTokenSet, routes);
  if (multiTokenMatches.length > 0) {
    return multiTokenMatches.some(({ route }) => route.surfaces.includes(requestedSurface))
      ? undefined
      : `Multi-token task route is not compatible with requested surface ${requestedSurface}.`;
  }
  const singleTokenMatches = collectSingleTokenMatches(queryTokenSet, routes);
  if (singleTokenMatches.length > 0 && !singleTokenMatches.some(({ route }) => route.surfaces.includes(requestedSurface))) {
    return `Single-token task route is not compatible with requested surface ${requestedSurface}.`;
  }
  return undefined;
}

function parseTaskRouteDefinition(value: unknown, context: string): TaskRouteDefinition {
  const route = requireRecord(value, context);
  const keys = Object.keys(route).sort();
  if (keys.length !== ROUTE_KEYS.length || keys.some((key, index) => key !== ROUTE_KEYS[index])) {
    throw new Error(`${context} must contain exactly: ${ROUTE_KEYS.join(", ")}.`);
  }
  if (typeof route.taskFamily !== "string" || !TASK_FAMILY_SET.has(route.taskFamily)) {
    throw new Error(`${context}.taskFamily is not a stable task family.`);
  }
  if (typeof route.skill !== "string" || !route.skill.trim()) {
    throw new Error(`${context}.skill must be a non-empty string.`);
  }
  const canonicalQuery = requireEnglishPhrase(route.canonicalQuery, `${context}.canonicalQuery`);
  const surfaces = parseSurfaces(route.surfaces, `${context}.surfaces`);
  const aliases = parseAliases(route.aliases, `${context}.aliases`);
  return {
    taskFamily: route.taskFamily as TaskFamily,
    skill: route.skill.trim(),
    surfaces,
    canonicalQuery,
    aliases,
  };
}

function parseSurfaces(value: unknown, context: string): TaskSurface[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  const surfaces: TaskSurface[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !TASK_SURFACE_SET.has(entry)) {
      throw new Error(`${context} contains an unknown surface: ${String(entry)}.`);
    }
    if (surfaces.includes(entry as TaskSurface)) {
      throw new Error(`${context} must not contain duplicate surfaces.`);
    }
    surfaces.push(entry as TaskSurface);
  }
  return surfaces;
}

function parseAliases(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  const aliases = value.map((entry, index) => requireEnglishPhrase(entry, `${context}[${index}]`));
  const normalized = aliases.map(normalizeTaskRoutingQuery);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${context} contains duplicate normalized aliases.`);
  }
  return aliases;
}

function requireEnglishPhrase(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  if (!normalizeTaskRoutingQuery(value)) {
    throw new Error(`${context} must contain English routing tokens.`);
  }
  return value.trim();
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeRoutes(routes: readonly TaskRouteDefinition[]): NormalizedRoute[] {
  return routes
    .map((route) => {
      if (!TASK_FAMILY_SET.has(route.taskFamily)) {
        throw new Error(`Route contains unknown task family: ${String(route.taskFamily)}.`);
      }
      const phrases = [...route.aliases, route.canonicalQuery]
        .map((phrase) => normalizeTaskRoutingQuery(phrase))
        .filter((phrase) => phrase.length > 0)
        .filter((phrase, index, all) => all.indexOf(phrase) === index)
        .map((phrase) => ({ value: phrase, tokens: phrase.split(" ") }));
      return { route, phrases };
    })
    .sort((left, right) => compareTaskFamily(left.route.taskFamily, right.route.taskFamily));
}

function collectExactMatches(
  normalizedQuery: string,
  queryTokens: string[],
  routes: readonly NormalizedRoute[],
): Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> {
  const paddedQuery = ` ${normalizedQuery} `;
  const matches: Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> = [];
  for (const route of routes) {
    for (const phrase of route.phrases) {
      if (phrase.tokens.length <= queryTokens.length && paddedQuery.includes(` ${phrase.value} `)) {
        matches.push({ route: route.route, phrase });
      }
    }
  }
  return matches;
}

function collectMultiTokenMatches(
  queryTokens: ReadonlySet<string>,
  routes: readonly NormalizedRoute[],
): Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> {
  const matches: Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> = [];
  for (const route of routes) {
    const phrases = route.phrases.filter((phrase) =>
      phrase.tokens.length > 1 && phrase.tokens.every((token) => queryTokens.has(token)));
    const best = strongestPhrase(phrases);
    if (best) matches.push({ route: route.route, phrase: best });
  }
  return matches;
}

function strongestExactMatches(
  matches: Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }>,
): Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> {
  if (matches.length === 0) return [];
  const longestTokenCount = Math.max(...matches.map((match) => match.phrase.tokens.length));
  const tokenLongest = matches.filter((match) => match.phrase.tokens.length === longestTokenCount);
  const longestLength = Math.max(...tokenLongest.map((match) => match.phrase.value.length));
  return tokenLongest.filter((match) => match.phrase.value.length === longestLength);
}

function collectSingleTokenMatches(
  queryTokens: ReadonlySet<string>,
  routes: readonly NormalizedRoute[],
): Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> {
  const matches: Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }> = [];
  for (const route of routes) {
    const phrases = route.phrases.filter((phrase) =>
      phrase.tokens.some((token) => queryTokens.has(token)));
    const best = strongestPhrase(phrases);
    if (best) matches.push({ route: route.route, phrase: best });
  }
  return matches;
}

function strongestPhrase(phrases: readonly NormalizedPhrase[]): NormalizedPhrase | undefined {
  return [...phrases].sort((left, right) =>
    right.tokens.length - left.tokens.length
    || right.value.length - left.value.length
    || compareText(left.value, right.value))[0];
}

function resolveMatchedCandidates(options: {
  candidates: Array<{ route: TaskRouteDefinition; phrase: NormalizedPhrase }>;
  normalizedQuery: string;
  requestedSurface?: TaskSurface;
  matchKind: Exclude<TaskRouteMatchKind, "explicit">;
  confidence: Exclude<TaskRouteConfidence, "none">;
  status?: "matched" | "fallback";
  reason: string;
}): TaskRouteResult {
  const byFamily = new Map<TaskFamily, { route: TaskRouteDefinition; phrase: NormalizedPhrase }>();
  for (const candidate of options.candidates) {
    const current = byFamily.get(candidate.route.taskFamily);
    if (!current || comparePhrases(candidate.phrase, current.phrase) < 0) {
      byFamily.set(candidate.route.taskFamily, candidate);
    }
  }
  const candidates = [...byFamily.values()].sort((left, right) =>
    compareTaskFamily(left.route.taskFamily, right.route.taskFamily));
  if (candidates.length !== 1) {
    return {
      status: "ambiguous",
      confidence: "low",
      surface: options.requestedSurface ?? uniqueSurface(candidates.map(({ route }) => route)),
      candidateTaskFamilies: candidates.map(({ route }) => route.taskFamily),
      effectiveScopes: ["router"],
      normalizedQuery: options.normalizedQuery,
      matchKind: options.matchKind,
      reason: `${options.reason} Multiple task families remain compatible.`,
    };
  }

  const selected = candidates[0];
  const surface = options.requestedSurface ?? uniqueSurface([selected.route]);
  const confidence = surface === undefined && options.confidence !== "low" ? "low" : options.confidence;
  return selectedRouteResult(selected.route, {
    status: options.status ?? "matched",
    confidence,
    normalizedQuery: options.normalizedQuery,
    requestedSurface: options.requestedSurface,
    matchKind: options.matchKind,
    matchedAlias: selected.phrase.value,
    reason: surface === undefined
      ? `${options.reason} The route spans multiple surfaces, so confidence is reduced.`
      : options.reason,
  });
}

function selectedRouteResult(route: TaskRouteDefinition, options: {
  status: "matched" | "fallback";
  confidence: TaskRouteConfidence;
  normalizedQuery: string;
  requestedSurface?: TaskSurface;
  matchKind: TaskRouteMatchKind;
  matchedAlias?: string;
  reason: string;
}): TaskRouteResult {
  return {
    status: options.status,
    confidence: options.confidence,
    surface: options.requestedSurface ?? (route.surfaces.length === 1 ? route.surfaces[0] : undefined),
    taskFamily: route.taskFamily,
    skill: route.skill,
    candidateTaskFamilies: [route.taskFamily],
    effectiveScopes: options.status === "matched"
      ? [...TASK_ROUTING_AUTO_SCOPES]
      : ["active"],
    normalizedQuery: options.normalizedQuery,
    canonicalQuery: route.canonicalQuery,
    matchKind: options.matchKind,
    matchedAlias: options.matchedAlias,
    reason: options.reason,
  };
}

function noRouteResult(options: {
  normalizedQuery: string;
  requestedSurface?: TaskSurface;
  reason: string;
  confidence: "low" | "none";
}): TaskRouteResult {
  return {
    status: "none",
    confidence: options.confidence,
    surface: options.requestedSurface,
    candidateTaskFamilies: [],
    effectiveScopes: ["active"],
    normalizedQuery: options.normalizedQuery,
    reason: options.reason,
  };
}

function uniqueSurface(routes: readonly TaskRouteDefinition[]): TaskSurface | undefined {
  const surfaces = new Set(routes.flatMap((route) => route.surfaces));
  return surfaces.size === 1 ? [...surfaces][0] : undefined;
}

function compareTaskFamily(left: TaskFamily, right: TaskFamily): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePhrases(left: NormalizedPhrase, right: NormalizedPhrase): number {
  return right.tokens.length - left.tokens.length
    || right.value.length - left.value.length
    || compareText(left.value, right.value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
