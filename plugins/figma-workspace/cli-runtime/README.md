# Figma Workspace CLI Package

This private Node package builds the checked-in CLI/runtime artifacts used by the Figma Workspace plugin. It keeps the official Figma remote MCP behind the CLI transport, does not register a local MCP server, and exposes no supported typed import facade.

The public agent contract belongs to the [plugin README](../README.md) and generated command help. From the plugin root, use:

```text
npm --silent run figma -- <command> --help
```

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

Live verification is a separate Design-only command at the plugin root: `npm run test:live`. It is excluded from this package's offline test suite and is not required for documentation-only changes.
