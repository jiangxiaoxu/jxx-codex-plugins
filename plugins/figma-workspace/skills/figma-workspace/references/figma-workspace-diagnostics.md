# Figma Workspace Diagnostics

Use this reference only to choose the narrowest repair. Command results and diagnostics are authoritative.

## Choose The Repair

- For missing packaged docs, canonical corpus, Plugin API index, or TypeScript assets, run the public local-only `figma:doctor` command. It requires no Figma target.
- For TypeScript or Plugin API diagnostics, repair the reported source location, use `figma:api:search -- <symbol>` to locate the declaration, and use `figma:api:read -- <api-id>` when its complete record is required.
- For a missing or conflicting Figma target, pass a supported full node URL or an explicit file-plus-node pair. For a surface mismatch, choose the correct Design, FigJam, or Slides surface and compatible API.
- For artifact, capture, or result-path failures, use a real non-linked permitted directory. See [local artifacts](figma-workspace-artifacts.md) and [safety](figma-workspace-safety.md).
- For a complete oversized result, read `outputFiles.cliResultFile` instead of parsing Restricted Markdown stdout.

## Preserve Mutation Evidence

- Repair and rerun `not_started` only after the failure occurred before dispatch.
- For `failed_atomic`, use stdout's compact remote error summary, repair the script, then retry safely; the returned `use_figma` host error confirms no file changes. Read the sidecar for complete diagnostics when needed.
- For `outcome_unknown`, inspect, read back, or tag-reconcile the intended Figma effect before any retry; partial side effects may exist.
- For `succeeded` with capture processing failure, capture the affected node separately. `Status: failed after execution` is only a local stage failure after confirmed execution; repair it and do not rerun the confirmed mutation.
- For OAuth rate limiting, 5xx responses, or network refresh faults, retain the existing credential and retry the narrow auth step later. Ask the user before starting browser authorization for terminal auth failure.
