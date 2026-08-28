# Code Connect

Code Connect maps published Figma components to existing code UI components. Use the public fixed-leaf workflow below. These commands are Design-only and do not execute Plugin API scripts or create `.figma.ts`/`.figma.js` template files.

## Workflow

Run each command with the same explicit `--file <Design URL|fileKey>`. Read the command's generated `--help` for output and path options.

1. `figma:code-connect:inspect` lists components that can be mapped in the file.
2. `figma:code-connect:plan --input <manifest.json|->` validates a mapping manifest, reads live mappings, and writes an immutable plan artifact. The result contains a `planDigest` and per-item `create`, `noop`, `replace`, or `conflict` actions.
3. `figma:code-connect:apply --plan <path> --confirm-plan <planDigest>` is the only write operation. It re-reads the mapping snapshot, rejects stale plans and unapproved conflicts, sends one bulk write, then performs readback verification.
4. `figma:code-connect:verify --plan <path>` safely re-reads the plan mappings and reports `matched`, `missing`, `mismatch`, or `unavailable`. Use it after an unknown outcome instead of replaying `apply`.

`apply` never dispatches when the confirmation digest is missing or mismatched, or when the file target, artifact, or live snapshot is invalid; these cases are `executionOutcome: not_started`. A remote error, timeout, or response loss after dispatch is `outcome_unknown`; reconcile with `verify` before retrying. If Figma confirms the write but verification fails, treat the write as succeeded and verify again later.

## Manifest

The input is JSON. `--file` is the only file identity; do not put a file URL or file key in the manifest.

```json
{
  "schemaVersion": 1,
  "scope": { "nodeId": "1:2" },
  "client": { "languages": "typescript", "frameworks": "react" },
  "mappings": [
    {
      "nodeId": "3:4",
      "componentName": "Button",
      "source": "src/components/Button.tsx",
      "label": "React",
      "conflictPolicy": "fail"
    }
  ]
}
```

`schemaVersion` is `1`; `scope.nodeId` and every mapping use simple Figma node IDs. `mappings` contains 1 to 64 entries and has no duplicate `(nodeId, label)` identities. `componentName`, `source`, and `label` are non-empty strings. `label` must be one of the values advertised by the live bulk-write contract. `client` is optional; omitted language or framework is reported as `unknown` in the plan.

`conflictPolicy` defaults to `fail`. An existing different mapping blocks the plan/apply path unless that item explicitly uses `replace`. Unknown fields, template fields such as `template` or `templateDataJson`, empty values, unsupported labels, and non-Design targets are rejected. The CLI does not scan the repository or check that `source` exists.

## Scope and recovery

Only simple mappings whose identity and values can be fully read back are supported. Code Connect templates, parser files, and template dialect examples are outside this workflow; use the upstream escape hatch for an uncovered official capability, and use `figma:run` only for independent canvas work.

Plans are single-use immutable artifacts. Keep the plan file and digest together, do not edit either, and generate a new plan after changing the manifest or resolving a conflict. A missing or invalid plan returns `executionOutcome: not_started`. When apply reports `outcome_unknown`, do not send another bulk write until `verify` establishes the remote state.

## Prerequisites

- The target is a Design file that the current identity can read and edit.
- Components are published and available to Code Connect in that file.
- The live contract exposes the required Code Connect capabilities and accepted label enum.
- The code component identity is supplied explicitly in `source` and `componentName`; this workflow does not infer or modify source files.
