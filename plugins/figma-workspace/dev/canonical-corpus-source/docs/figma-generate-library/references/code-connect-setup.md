> Part of the [figma-generate-library skill](canonical:figma-generate-library/SKILL.md).

# Code Connect Setup Reference

Code Connect links published Figma components to existing code UI components. Use the public Design-only workflow; do not create or execute Code Connect template files.

## Mapping workflow

Run the four commands with the same explicit `--file <Design URL|fileKey>`:

1. `figma:code-connect:inspect` discovers components available for mapping.
2. `figma:code-connect:plan --input <manifest.json|->` validates a manifest, reads current mappings, and writes an immutable plan with a `planDigest`.
3. `figma:code-connect:apply --plan <path> --confirm-plan <planDigest>` is the only Code Connect write. It re-reads mapping fingerprints, rejects stale plans and unapproved conflicts, sends one bulk update, and reads back each mapping.
4. `figma:code-connect:verify --plan <path>` safely re-reads the plan and reports `matched`, `missing`, `mismatch`, or `unavailable`.

Use `figma:docs:read` with `canonical:figma-code-connect/SKILL.md` for the complete mapping contract and recovery rules. For a capability not represented by the four commands, inspect its live schema and use the generic `figma:upstream:list` -> `figma:upstream:read` -> `figma:upstream:call` escape hatch.

## Manifest

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

Only simple node IDs and the fields shown above are supported. `mappings` contains 1 to 64 unique `(nodeId, label)` entries; `componentName`, `source`, and `label` are non-empty. `label` must be accepted by the live bulk-write schema. `client` is optional and omitted values are reported as `unknown` in the plan. `conflictPolicy` defaults to `fail`; use `replace` only for an intentional replacement.

The manifest must not include a file URL/file key, `template`, or `templateDataJson`. The CLI does not scan the repository or validate that `source` exists. Non-Design targets, unknown fields, duplicate identities, unsupported labels, and empty values fail before any write.

## Variable code syntax

Code Connect mapping and Figma variable code syntax are separate concerns. Variable syntax may be set through native Plugin API code in a local `.figma.ts` script executed with `figma:run`; it does not belong in a Code Connect manifest.

When setting syntax, prefer exact token names from the codebase and keep transformations consistent:

```js
variable.setVariableCodeSyntax('WEB', 'var(--color-bg-primary)')
variable.setVariableCodeSyntax('ANDROID', 'Theme.colorBgPrimary')
variable.setVariableCodeSyntax('iOS', 'Color.bgPrimary')
```

## Recovery

Plans are immutable and digest-bound. A missing or mismatched confirmation, invalid artifact, target mismatch, stale snapshot, or unapproved conflict returns `executionOutcome: not_started` and dispatches no write. A timeout, response loss, or remote error after dispatch is `outcome_unknown`; run `figma:code-connect:verify` before retrying. If Figma confirms the write but readback fails, retain `succeeded` and verify again instead of replaying the bulk write.
