# Figma Workspace Local Artifacts

Use this reference when an invocation writes local outputs or needs same-machine mutation coordination. Public command help and runtime schemas are authoritative.

## Invocation-Local Outputs

- The CLI has no persistent task context, workspace record, history, or file-selection store. Pass a Figma target with every invocation that requires one; targetless upstream lookup never inherits one.
- Small results remain readable in Restricted Markdown stdout under the default inline threshold. Keep that default for normal agent calls; do not increase it merely to avoid a sidecar. Consider a larger threshold only when the user needs the complete result rendered inline for direct reading or visual presentation.
- When stdout names `outputFiles.cliResultFile`, treat that complete JSON file as the machine-readable result. Inspect its keys, paths, types, and structure, use targeted extraction to read only the fields needed for the task, then expand further only when necessary. Never parse the Restricted Markdown stdout envelope as JSON.
- A `figma:upstream:call` within the response budget writes a sanitized visible-protocol sidecar, including `content`, `structuredContent`, `isError`, and standard ContentBlock `annotations`. It omits protocol `_meta` at every protocol-object layer, never exposes tool-definition annotations, and never removes an ordinary `_meta` field nested inside `structuredContent` business data. An over-budget response does not write a payload sidecar; it returns a bounded resource-limit diagnostic and may write a diagnostic-only sidecar. Typed commands create that upstream-response sidecar only for a remote error, inline truncation, or unrendered non-text content.
- Provide explicit `--output-dir`, `--image-file`, or download output options when another shell step needs a predictable local location. Do not derive paths from a prior invocation.
- Managed roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points. Publication is atomic, so a failed write does not replace an existing artifact.

## Mutation Coordination And Recovery

- The temporary same-machine fileKey lock covers `figma:run`, `figma:assets:apply`, `figma:code-connect:apply`, and `figma:upstream:call` only when that call resolves a fileKey. It does not cover every mutation; read-only calls, captures, and asset downloads do not take it.
- The lock coordinates local processes only. It does not provide distributed, network-share, shared-volume, or power-loss durability.
- When Figma directly returns a `use_figma` script error, `executionOutcome: "failed_atomic"` and `Status: failed atomically` confirm no file changes. This applies to `figma:run` and direct `figma:upstream:call`; stdout has a compact error summary and the sidecar keeps visible-protocol diagnostics. Repair and retry safely. A post-dispatch error from another direct official tool is `outcome_unknown`, so read back and reconcile before retrying.
- If local artifact or lock post-processing fails after a confirmed remote mutation, stdout reports `Status: failed after execution`. Preserve the result and repair the named local stage instead of rerunning the mutation.
- Artifacts can contain sensitive Figma data. Retain them only for the caller's recovery needs, then remove them through the owning shell workflow.
