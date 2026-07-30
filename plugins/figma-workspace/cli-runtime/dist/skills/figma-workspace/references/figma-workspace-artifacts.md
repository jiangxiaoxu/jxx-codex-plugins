# Figma Workspace Local Artifacts

Use this reference when an invocation writes local outputs or needs same-machine mutation coordination. Public command help and runtime schemas are authoritative.

## Invocation-Local Outputs

- The CLI has no persistent task context, workspace record, history, or file-selection store. Pass the Figma target with every remote invocation.
- Small results remain readable in Restricted Markdown stdout under the default inline threshold. Keep that default for normal agent calls; do not increase it merely to avoid a sidecar. Consider a larger threshold only when the user needs the complete result rendered inline for direct reading or visual presentation.
- When stdout names `outputFiles.cliResultFile`, treat that complete JSON file as the machine-readable result. Inspect its keys, paths, types, and structure, use targeted extraction to read only the fields needed for the task, then expand further only when necessary. Never parse the Restricted Markdown stdout envelope as JSON.
- Provide explicit `--output-dir`, `--image-file`, or download output options when another shell step needs a predictable local location. Do not derive paths from a prior invocation.
- Managed roots, existing ancestors, and final targets reject symbolic links, Windows junctions, and other reparse points. Publication is atomic, so a failed write does not replace an existing artifact.

## Mutation Coordination And Recovery

- Mutating calls are serialized per Figma fileKey through a temporary same-machine lock. Read-only calls, captures, and asset downloads do not take that lock.
- The lock coordinates local processes only. It does not provide distributed, network-share, shared-volume, or power-loss durability.
- If local artifact or lock post-processing fails after a confirmed remote mutation, stdout reports `Status: failed after execution`. Preserve the result and repair the named local stage instead of rerunning the mutation.
- Artifacts can contain sensitive Figma data. Retain them only for the caller's recovery needs, then remove them through the owning shell workflow.
