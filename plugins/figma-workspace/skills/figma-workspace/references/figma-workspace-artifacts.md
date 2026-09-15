# Figma Workspace Local Artifacts

Use this reference when an invocation writes local outputs or needs same-machine mutation coordination. Public command help and runtime schemas are authoritative.

## Invocation-Local Outputs

- The CLI has no persistent task context, workspace record, history, or file-selection store. Pass a Figma target with every invocation that requires one; targetless upstream lookup never inherits one.
- Small results remain readable in Restricted Markdown stdout under the default inline threshold. Keep that default for normal agent calls; do not increase it merely to avoid a result receipt. Consider a larger threshold only when the user needs the complete result rendered inline for direct reading or visual presentation.
- When stdout names `outputFiles.resultFile`, treat that complete JSON receipt as the machine-readable result. The `Full result` section supplies directly executable commands for its advertised filters; expand only the fields needed for the task. Never parse the Restricted Markdown stdout envelope as JSON.
- When inline output is omitted, the runtime publishes one complete `outputFiles.resultFile` receipt with `kind: "figma-cli-result"` and `schemaVersion: 1`. Its `jq.full` filter is `.`, `jq.status` selects the execution status fields, and `jq.data` selects the command's business data. Direct and typed protocol calls may include sanitized `upstream` content with `content`, `structuredContent`, `isError`, and standard ContentBlock `annotations`; protocol `_meta` and tool-definition annotations are removed, while business `_meta` nested in `structuredContent` remains unchanged. An over-budget direct response does not write a payload receipt and returns a bounded resource-limit diagnostic.
- Provide explicit `--output-dir`, `--image-file`, or download output options when another shell step needs a predictable local location. Do not derive paths from a prior invocation.
- Managed roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points. Publication is atomic, so a failed write does not replace an existing artifact.

## Mutation Coordination And Recovery

- The temporary same-machine fileKey lock covers `figma:run`, `figma:assets:apply`, `figma:code-connect:apply`, and `figma:upstream:call` only when that call resolves a fileKey. It does not cover every mutation; read-only calls, captures, and asset downloads do not take it.
- The lock coordinates local processes only. It does not provide distributed, network-share, shared-volume, or power-loss durability.
- When Figma directly returns a `use_figma` script error, `executionOutcome: "failed_atomic"` and `Status: failed atomically` confirm no file changes. This applies to `figma:run` and direct `figma:upstream:call`; stdout has a compact error summary and the result receipt keeps complete execution diagnostics. Repair and retry safely. A post-dispatch error from another direct official tool is `outcome_unknown`, so read back and reconcile before retrying.
- If local artifact or lock post-processing fails after a confirmed remote mutation, stdout reports `Status: failed after execution`. Preserve the result and repair the named local stage instead of rerunning the mutation.
- Artifacts can contain sensitive Figma data. Retain them only for the caller's recovery needs, then remove them through the owning shell workflow.

For an inspect receipt, `jq.data` selects the page's `nodes`; the receipt also advertises `jq.nextCursor` and `jq.hasMore` filters. Continue by passing the opaque cursor to a new invocation with the same file and node until `hasMore` is false.
