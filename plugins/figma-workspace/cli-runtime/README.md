# Figma Workspace CLI Package

This private Node package builds the checked-in CLI/runtime artifacts used by the Figma Workspace plugin. It keeps the official Figma remote MCP behind the CLI transport, does not register a local MCP server, and exposes no supported typed import facade.

The public 0.6.2 agent contract is a stateless set of fixed `figma:*` leaf commands. Commands that require a Figma file or node target receive it explicitly; targetless `figma:upstream:list` and `figma:upstream:read` do not inherit one, and `figma:upstream:call` follows its live schema. `list` and `read` can report local first-class `coverage`, but never reject a covered direct call. Shell orchestration owns local `.figma.ts` script creation for native Plugin API work; Code Connect mappings use the dedicated workflow below. The [plugin README](../README.md) and generated command help own the public contract. From the plugin root, use:

```text
npm --silent run figma:help
npm --silent run figma:api:search -- "figma.createFrame"
npm --silent run figma:api:read -- "<api-id-from-search>"
npm --silent run figma:run -- --help
```

Catalog accepts `--limit <1..100>`. Search accepts `--limit <1..10>` and `--snippet-lines <1..16>`. These display-oriented limits clamp safe out-of-range integers with a `parameterAdjustments` notice. Traversal depth, pagination offset, capture dimensions, and remote inline-result bytes remain strict and publish their accepted ranges in leaf help. Search applies one 12000-byte UTF-8 budget across returned snippets and does not cap individual snippets before that aggregate budget.

Code Connect is a Design-only, manifest-driven workflow: `figma:code-connect:inspect`, `figma:code-connect:plan --input <manifest.json|->`, `figma:code-connect:apply --plan <path> --confirm-plan <planDigest>`, then `figma:code-connect:verify --plan <path>`. It supports simple mappings only, rejects template fields, and uses immutable digest-bound plans with stale-snapshot checks. `apply` is the only write; after `outcome_unknown`, verify before retrying.

## Mutation Outcomes

`figma:run` and direct `figma:upstream:call` use `executionOutcome: "failed_atomic"` when Figma directly returns a `use_figma` script error: the failed script made no file changes, so repair and retry safely. A post-dispatch error from another direct official tool is `outcome_unknown`, as are response loss and truncation; read back and reconcile before retrying. Direct calls within the response budget write a sanitized visible-protocol sidecar; an over-budget response does not persist its payload and returns a bounded resource-limit diagnostic (with a diagnostic-only sidecar when emitted). Typed commands create their upstream-response sidecar only for a remote error, inline truncation, or unrendered non-text content. Sidecars omit protocol `_meta`, retain standard ContentBlock `annotations` and business fields inside `structuredContent`, and never expose tool-definition annotations. `Status: failed after execution` is reserved for local post-processing failure after `executionOutcome: "succeeded"`.

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
