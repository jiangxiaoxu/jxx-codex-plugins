# Figma Workspace Diagnostics

Use this reference only to choose the narrowest repair. Command results and diagnostics are authoritative.

## Choose The Repair

- For missing installed project docs, canonical corpus, Plugin API index, or TypeScript assets, run `figma:doctor` with the task state file and follow its reported repair. Upstream snapshot drift is a maintenance concern, not a doctor diagnosis.
- For TypeScript or Plugin API diagnostics, repair the reported source location and use `figma:api:search -- <symbol>` for the declaration.
- For rejected state, legacy arrays, or unsafe persisted paths, preserve the file and reopen a new state file. See [sessions](figma-workspace-sessions.md).
- For missing file context, run `figma:open` with the same state file or use a supported node URL or structured target. For a surface mismatch, choose the correct Design, FigJam, or Slides surface and compatible API.
- For workspace, asset, capture, or result-path failures, use a real non-linked permitted directory. See [safety](figma-workspace-safety.md).
- For a complete oversized result, read `outputFiles.cliResultFile` instead of parsing Restricted Markdown stdout.

## Preserve Mutation Evidence

- Repair and rerun `not_started` only after the failure occurred before dispatch.
- For `outcome_unknown`, inspect, read back, or tag-reconcile the intended Figma effect before any retry.
- For `succeeded` with capture processing failure, capture the affected node separately. For `Status: failed after execution`, repair the named local stage and do not rerun the confirmed mutation.
- For OAuth rate limiting, 5xx responses, or network refresh faults, retain the existing credential and retry the narrow auth step later. Ask the user before starting browser authorization for terminal auth failure.
