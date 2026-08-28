# Code Connect Recovery Patterns

Keep Code Connect changes explicit and recoverable. The public workflow is `inspect` -> `plan` -> `apply --confirm-plan` -> `verify`.

## Multiple mappings

Put related mappings in one manifest (up to 64 entries). Use a stable simple `nodeId`, a non-empty code `componentName`, an explicit `source` path, and the live contract's `label`. Keep each `(nodeId, label)` identity unique. Generate one plan and review every action before confirming it.

## Existing mappings

An identical existing mapping is a `noop` and is not written. A different existing mapping is a `conflict` when `conflictPolicy` is `fail`; change that item to `replace` only when replacement is intentional, then generate and review a new plan. Never edit a plan artifact to bypass a conflict.

## Stale plans

The plan contains fingerprints for the mappings observed during planning. `apply` compares those fingerprints with a fresh read. If another actor changed a mapping, or the mapping cannot be read safely, no write is dispatched. Resolve the remote state, update the manifest if needed, and create a new plan.

## Unknown outcomes

If `apply` reports `outcome_unknown`, assume the bulk write may have happened. Run `verify` with the same plan, inspect each status, and reconcile before retrying. If Figma confirmed the write but local readback failed, the outcome remains `succeeded`; do not replay the write solely because verification was incomplete.

## Unsupported artifacts

Do not put `template` or `templateDataJson` in a manifest or plan. Parser-based `.figma.js` and parserless `.figma.ts` Code Connect files are not inputs to this workflow. Use the generic upstream path for an official capability that is not represented by these commands, and reserve `figma:run` for native Plugin API scripts.
