import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "figma-task-routing-"));
const compiledFile = resolve(temporaryRoot, "task-routing.mjs");

await build({
  entryPoints: [resolve(packageRoot, "src/runtime/task-routing.ts")],
  outfile: compiledFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
});

const routing = await import(pathToFileURL(compiledFile).href);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function route(taskFamily, surfaces, canonicalQuery, aliases) {
  return {
    taskFamily,
    skill: `figma-${taskFamily}`,
    surfaces,
    canonicalQuery,
    aliases,
  };
}

function validRoutes() {
  return [
    route("code-connect", ["design"], "map figma components to source code", ["connect components to code"]),
    route("create-file", ["design", "figjam", "slides"], "create a new figma file", ["create figma file"]),
    route("design-editing", ["design"], "edit an existing figma design", ["design", "edit canvas"]),
    route("design-generation", ["design"], "generate a new product design", ["generate design", "create mockup"]),
    route("design-to-code", ["design"], "implement a figma design in code", ["implement interface", "convert design"]),
    route("diagram", ["figjam"], "generate an editable figjam diagram", ["mermaid diagram", "architecture diagram"]),
    route("figjam", ["figjam"], "edit a figjam collaboration board", ["figjam board", "sticky connector"]),
    route("library-generation", ["design"], "generate a reusable design system library", ["create library", "build token system"]),
    route("motion", ["design"], "author motion in a figma prototype", ["author motion prototype"]),
    route("motion-implementation", ["design"], "implement figma motion in application code", ["implement motion in code"]),
    route("slides", ["slides"], "create and edit a figma slide deck", ["slides deck", "presentation layout"]),
    route("swiftui", ["design"], "translate a figma design into swiftui", ["build swiftui view"]),
  ];
}

function resolveRoute(query, options = {}) {
  return routing.resolveTaskRoute({ query, routes: validRoutes(), ...options });
}

test("normalizes English routing text with NFKC, lowercase, punctuation, and whitespace", () => {
  assert.equal(
    routing.normalizeTaskRoutingQuery("  ＧＥＮＥＲＡＴＥ—Design!!\tNow  "),
    "generate design now",
  );
  assert.equal(routing.normalizeTaskRoutingQuery("创建一个设计"), "");
});

test("strict catalog parser accepts all stable families and rejects schema drift", () => {
  const parsed = routing.parseTaskRoutingCatalog({
    schemaVersion: 1,
    routes: validRoutes(),
  });
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.routes.map((entry) => entry.taskFamily), validRoutes().map((entry) => entry.taskFamily));

  assert.throws(
    () => routing.parseTaskRoutingCatalog({ schemaVersion: 2, routes: validRoutes() }),
    /schemaVersion must be 1/u,
  );
  assert.throws(
    () => routing.parseTaskRoutingCatalog({ schemaVersion: 1, routes: validRoutes().slice(1) }),
    /exactly 12 routes/u,
  );
  assert.throws(
    () => routing.parseTaskRoutingCatalog({ schemaVersion: 1, routes: validRoutes(), generatedAt: "unexpected" }),
    /must contain exactly/u,
  );
});

test("loads the repository route catalog without maintaining test-only aliases", () => {
  const catalog = routing.loadTaskRoutingCatalog(resolve(
    packageRoot,
    "../skills/figma-workspace/references/canonical-corpus/routes.json",
  ));
  assert.equal(catalog.routes.length, 12);
  assert.deepEqual(
    catalog.routes.map((entry) => entry.taskFamily),
    [...catalog.routes.map((entry) => entry.taskFamily)].sort(),
  );
});

test("repository aliases cover every stable task family deterministically", () => {
  const catalog = routing.loadTaskRoutingCatalog(resolve(
    packageRoot,
    "../skills/figma-workspace/references/canonical-corpus/routes.json",
  ));
  for (const route of catalog.routes) {
    const result = routing.resolveTaskRoute({
      query: route.aliases[0],
      routes: catalog.routes,
    });
    assert.equal(result.status, "matched", route.taskFamily);
    assert.equal(result.taskFamily, route.taskFamily);
    assert.deepEqual(result.candidateTaskFamilies, [route.taskFamily]);
    assert.deepEqual(result.effectiveScopes, ["active", "conditional", "router"]);
    assert.equal(result.effectiveScopes.includes("examples"), false);
  }
});

test("strict route validator rejects unsorted families, duplicate aliases, surfaces, and extra fields", () => {
  const unsorted = validRoutes();
  [unsorted[0], unsorted[1]] = [unsorted[1], unsorted[0]];
  assert.throws(() => routing.parseTaskRouteDefinitions(unsorted), /strictly sorted/u);

  const duplicateAlias = validRoutes();
  duplicateAlias[1].aliases = [duplicateAlias[0].aliases[0].toUpperCase()];
  assert.throws(() => routing.parseTaskRouteDefinitions(duplicateAlias), /alias .* duplicated/u);

  const duplicateSurface = validRoutes();
  duplicateSurface[0].surfaces = ["design", "design"];
  assert.throws(() => routing.parseTaskRouteDefinitions(duplicateSurface), /duplicate surfaces/u);

  const extraField = validRoutes();
  extraField[0].unexpected = true;
  assert.throws(() => routing.parseTaskRouteDefinitions(extraField), /must contain exactly/u);
});

test("longest contiguous alias wins before weaker token matches", () => {
  const result = resolveRoute("Please generate design for the dashboard");
  assert.equal(result.status, "matched");
  assert.equal(result.confidence, "high");
  assert.equal(result.taskFamily, "design-generation");
  assert.equal(result.matchKind, "exact-alias");
  assert.equal(result.matchedAlias, "generate design");
  assert.deepEqual(result.effectiveScopes, ["active", "conditional", "router"]);
});

test("unique non-contiguous multi-token route is medium confidence", () => {
  const result = resolveRoute("create a reusable figma library");
  assert.equal(result.status, "matched");
  assert.equal(result.confidence, "medium");
  assert.equal(result.taskFamily, "library-generation");
  assert.equal(result.matchKind, "multi-token");
});

test("single-token evidence produces a low-confidence fallback", () => {
  const result = resolveRoute("swiftui");
  assert.equal(result.status, "fallback");
  assert.equal(result.confidence, "low");
  assert.equal(result.taskFamily, "swiftui");
  assert.deepEqual(result.effectiveScopes, ["active"]);
});

test("tied routes are ambiguous with deterministic candidates and router-only scope", () => {
  const result = resolveRoute("motion");
  assert.equal(result.status, "ambiguous");
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.candidateTaskFamilies, ["motion", "motion-implementation"]);
  assert.deepEqual(result.effectiveScopes, ["router"]);
  assert.equal(result.taskFamily, undefined);
});

test("requested surface is a hard filter and never falls back across surfaces", () => {
  const result = resolveRoute("mermaid diagram", { requestedSurface: "design" });
  assert.equal(result.status, "none");
  assert.equal(result.confidence, "low");
  assert.equal(result.surface, "design");
  assert.deepEqual(result.candidateTaskFamilies, []);

  const strongerConflict = resolveRoute("slides deck design", { requestedSurface: "design" });
  assert.equal(strongerConflict.status, "none");
  assert.match(strongerConflict.reason, /not compatible with requested surface design/u);
});

test("explicit task family overrides inference but cannot override requested surface", () => {
  const explicit = resolveRoute("slides deck", { explicitTaskFamily: "code-connect" });
  assert.equal(explicit.status, "matched");
  assert.equal(explicit.confidence, "high");
  assert.equal(explicit.taskFamily, "code-connect");
  assert.equal(explicit.matchKind, "explicit");

  const conflict = resolveRoute("anything", {
    explicitTaskFamily: "diagram",
    requestedSurface: "design",
  });
  assert.equal(conflict.status, "none");
  assert.equal(conflict.confidence, "none");
  assert.deepEqual(conflict.candidateTaskFamilies, []);
});

test("missing surface does not default to design and reduces multi-surface confidence", () => {
  const result = resolveRoute("create figma file");
  assert.equal(result.status, "matched");
  assert.equal(result.confidence, "low");
  assert.equal(result.taskFamily, "create-file");
  assert.equal(result.surface, undefined);
});

test("English OOV and non-English queries fail closed without examples scope", () => {
  const oov = resolveRoute("unrelated frobnicator request");
  assert.equal(oov.status, "none");
  assert.equal(oov.confidence, "low");
  assert.deepEqual(oov.effectiveScopes, ["active"]);

  const nonEnglish = resolveRoute("创建一个设计");
  assert.equal(nonEnglish.status, "none");
  assert.equal(nonEnglish.confidence, "none");

  for (const result of [oov, nonEnglish, resolveRoute("motion"), resolveRoute("swiftui")]) {
    assert.equal(result.effectiveScopes.includes("examples"), false);
  }
});
