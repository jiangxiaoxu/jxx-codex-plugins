# Working with design systems

A Figma design system is a set of reusable design decisions, not a one-to-one copy of application code. Components, variables, text styles, effect styles, descriptions, and library publishing each carry different parts of the contract. The goal is a bridge that makes design intent clear and implementation mapping reliable.

## Start by classifying the task

Before editing, decide which of these outcomes the request actually needs:

- Create or refine a reusable system asset.
- Match a known code or token source while preserving Figma-friendly structure.
- Use an existing library to compose a design.
- Audit and repair drift between an existing design file and its stated conventions.
- Explore an idea where the result is deliberately provisional rather than a production library change.

This classification changes the safety bar. An exploratory button may accept a local scaffold; a published button needs stable variants, semantic tokens, documentation, and reviewable changes. Do not invent a production convention from an underspecified request.

## Read the system with the CLI

Use one absolute `--state-file` across related calls. Run `--help` for a selected command before using it, and use `npm --silent` so stdout remains readable Restricted Markdown.

```text
npm --silent run figma:metadata -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:libraries -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:design-system -- "button primary" --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:variables -- --file <figma-url-or-file-key> --state-file C:/work/project/.figma-workspace/state.json
```

Choose commands by question:

- `figma:metadata` maps unfamiliar file structure before narrow inspection.
- `figma:design-system` searches for existing component and token conventions; use repeatable `--library` filters when the owning library is known.
- `figma:libraries` identifies available local and published sources before duplicating assets.
- `figma:variables` inventories collections, modes, aliases, scopes, and values for token work.
- `figma:inspect` validates a known raw node ID after discovery.
- `figma:api:search` answers exact TypeScript Plugin API questions such as a property shape or method name. It is not a substitute for reading the design system.

## Translate intent, not just appearance

Components express reusable structure and variant/property behavior. Variables express individual values and mode-aware semantic choices. Text styles express typography systems; effect styles express composite visual effects. Prefer semantic layers over current-value matching: a primary button should bind its component token when one exists, even if a primitive color currently looks identical.

Names, descriptions, variants, code syntax, and scopes are part of the translation boundary. They need not reproduce code literally, but they must let a designer and implementer identify the same intent. Preserve deliberate differences between design exploration and production implementation instead of flattening them away.

## Make changes in `.figma.ts`

Read commands establish facts. Put every planned mutation in a local `.figma.ts` file and run it through `figma:script:run`. Begin with `figma:task:prepare` when a repairable workspace is needed; its JSON input identifies the Figma file, slug-style task name, absolute workspace directory, and surface.

```text
npm --silent run figma:task:prepare -- --input task.json --state-file C:/work/project/.figma-workspace/state.json
npm --silent run figma:script:run -- --input run-script.json --state-file C:/work/project/.figma-workspace/state.json
```

`run-script.json` supplies the saved session id, `.figma.ts` input path, and surface. TypeScript preflight is always enabled. Return concise evidence such as node ids, variable ids, component names, and validation notes. Make the script idempotent and tag created assets so `outcome_unknown` can be inspected and reconciled before running only confirmed missing work.

```ts
const component = figma.root
  .findAllWithCriteria({ types: ["COMPONENT"] })
  .find((node) => node.name === "Button");
if (!component) throw new Error("Expected Button component");

component.description =
  "Primary action button. Use once per view for the highest-priority action.";

return { componentId: component.id, name: component.name };
```

Fatal TypeScript preflight diagnostics report `executionOutcome: "not_started"`, confirming the request was not dispatched. Fix the `.figma.ts` diagnostics and rerun the same planned transaction. For `outcome_unknown`, inspect and reconcile tagged targets before any write. Do not bypass the script path with an untracked write.

## Review checklist and boundaries

- Reuse a library asset or token when it is the established owner; do not create a local near-duplicate.
- Check variants, component properties, descriptions, aliases, scopes, modes, and typography/effect-style boundaries relevant to the change.
- Inspect affected nodes after execution. For visible changes, capture the result and inspect the local image with `view_image`.
- Stop for clarification when a request could change a shared library's public naming, delete or repoint tokens, create incompatible variants, or choose among unresolved code/design sources of truth.
- Treat an exploratory artifact as local until the user confirms it should become a reusable or published system rule.

Continue with [components](canonical:figma-use/references/working-with-design-systems/wwds-components.md), [variables](canonical:figma-use/references/working-with-design-systems/wwds-variables.md), [effect styles](canonical:figma-use/references/working-with-design-systems/wwds-effect-styles.md), and [text styles](canonical:figma-use/references/working-with-design-systems/wwds-text-styles.md) for asset-specific guidance.
