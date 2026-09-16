# Figma Workspace CLI Package

This private Node package builds the checked-in CLI/runtime artifacts used by the Figma Workspace plugin. It keeps the official Figma remote MCP behind the CLI transport, does not register a local MCP server, and exposes no supported typed import facade.

The public 0.6.8 agent contract is a stateless set of fixed `figma:*` leaf commands. Commands that require a Figma file or node target receive it explicitly; targetless `figma:upstream:list` and `figma:upstream:read` do not inherit one, and `figma:upstream:call` follows its live schema. `list` and `read` can report local first-class `coverage`, but never reject a covered direct call. Shell orchestration owns local `.figma.ts` script creation for native Plugin API work; Code Connect mappings use the dedicated workflow below. The [plugin README](../README.md) and generated command help own the public contract. From the plugin root, use:

`assets:apply` reads one JSON document directly and expects an `assets` array. `assets:download` is a single-node CLI: pass `--target <node-url>` or `--file <url|key> --node <node-id>`, with optional default format and scale. Relative upload paths are based on the JSON file's directory, or the invocation cwd for stdin; see each generated leaf help for nested fields and examples.

```text
npm --silent run figma:help
npm --silent run figma:api:search -- "figma.createFrame"
npm --silent run figma:api:read -- "BaseNonResizableTextMixin.fontName"
npm --silent run figma:run -- --help
```

`figma:api:search <selector>` and `figma:api:read <selector>` each take one readable selector. A unique bare symbol can be read directly; when a bare symbol is ambiguous, search prints qualified selectors (for example, `BaseNonResizableTextMixin.fontName`) to use with `read`. Overloads belonging to the selected owner are returned together. Output is human-readable. API lookup does not require or expose declaration-file paths, source line numbers, or opaque IDs. Read each command's `--help` for display options and limits.

Catalog accepts `--limit <1..100>`. Search display limits clamp safe out-of-range integers with a `parameterAdjustments` notice. Ordinary `figma:inspect` accepts `--depth 0`, the default detail fields, comma-separated `--fields`, and an opaque `--cursor` for explicit live pages; `nodes`, `hasMore`, and `nextCursor` are returned per page. Traversal depth, pagination offset, capture dimensions, and remote inline-result bytes remain strict and publish their accepted ranges in leaf help.

Code Connect is a Design-only, manifest-driven workflow: `figma:code-connect:inspect`, `figma:code-connect:plan --input <manifest.json|->`, `figma:code-connect:apply --plan <path> --confirm-plan <planDigest>`, then `figma:code-connect:verify --plan <path>`. It supports simple mappings only, rejects template fields, and uses immutable digest-bound plans with stale-snapshot checks. `apply` is the only write; after `outcome_unknown`, verify before retrying.

## Mutation Outcomes

`figma:run` and direct `figma:upstream:call` use `executionOutcome: "failed_atomic"` when Figma directly returns a `use_figma` script error: the failed script made no file changes, so repair and retry safely. A post-dispatch error from another direct official tool is `outcome_unknown`, as are response loss and truncation; read back and reconcile before retrying. When a command needs a persisted result (for omitted inline output, a remote error, or unrendered non-text content), it publishes one complete `outputFiles.resultFile` receipt; stdout reports its path once. Direct calls over the response budget return a bounded resource-limit diagnostic without persisting the payload. Protocol receipts sanitize upstream content; `figma:run` keeps normalized execution data in `result`. Protocol `_meta` and tool-definition annotations are omitted, while business fields inside `structuredContent` remain available. For any command exposing `--output-dir`, callers must pass an absolute directory inside the current user workspace; file-only output options likewise use absolute workspace paths. The CLI's omitted-option fallback is an invocation-specific OS temp directory and is not a workflow contract. `Status: failed after execution` is reserved for local post-processing failure after `executionOutcome: "succeeded"`.

## Build And Test

Run these commands from this directory:

```text
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` regenerates the checked-in `dist/` artifacts. From a clean checkout or CI job only, run:

```text
npm run check:dist
```

It rebuilds and fails when `dist/` is not synchronized with source.

## Packaging

Inspect the private package payload before a release:

```text
npm pack --dry-run --json
```

The package payload contains runtime artifacts, this README, and npm package metadata. Public plugin packaging is owned by the plugin root.

## Maintenance

Follow the [Figma Workspace AI Agent Development Guide](../../../doc/figma-workspace-ai-agent-development.md) for source ownership, canonical corpus publication, release validation, and generated-output rules.

For official MCP contract drift, use the maintainer-only candidate workflow: `upstream:contract:capture`, `upstream:contract:report`, `upstream:contract:check`, and `upstream:contract:promote`. Capture and reporting do not accept a new baseline; promotion is a separate guarded action after CLI adaptation, validation, review, and explicit maintainer confirmation. Contract evidence may retain remote `_meta` and annotations for drift review, but protocol `_meta` and tool-definition annotations must not enter agent-facing runtime output. Read each command's `--help` for its exact arguments.

Live verification is a separate Design-only command at the plugin root: `npm run test:live`. It is excluded from this package's offline test suite and is not required for documentation-only changes.
