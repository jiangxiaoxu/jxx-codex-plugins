---
name: figma-upstream-contract-maintenance
description: Maintain the repo-local Figma CLI against official upstream MCP contract drift. Use when checking whether upstream tools, resources, schemas, or descriptions changed; adapting cli-runtime contracts, wrappers, help, runtime behavior, or tests; or reviewing and promoting a candidate upstream contract snapshot. This is a maintainer workflow, not a public Figma task skill.
---

# Figma Upstream Contract Maintenance

Treat the committed upstream snapshot as the accepted baseline. Capture live state into an ignored candidate first; promote it only after local adaptation, validation, review, and explicit maintainer confirmation. Promotion replaces the local accepted fixture, including its SHA-256, as reviewed drift evidence; it does not modify the remote MCP, GitHub upstream guide archive, or agent-facing documentation. Snapshot evidence can retain upstream annotations and protocol `_meta`; runtime outputs and sanitized sidecars must not expose them to agents.

## Workflow

1. Read [references/workflow.md](references/workflow.md) completely before running maintenance commands.
2. Inspect the worktree and preserve unrelated changes. Stop before overwriting an existing snapshot or candidate that may belong to another run.
3. Run the candidate capture command from `plugins/figma-workspace/cli-runtime`. Never capture directly into the committed snapshot.
4. Generate and review the semantic drift report. Compare tools by `name`, resources by `uri`, and resource templates by `uriTemplate`; do not infer changes from array indexes.
5. Adapt the owned CLI contracts, runtime, generated help, and focused tests for every behaviorally relevant drift. Prefer a clean breaking update over a compatibility layer.
6. Record one supported disposition and a non-empty rationale for every reported `changeId`, then regenerate the candidate report with that disposition file.
7. Run focused validation, then the package validation and candidate contract check described in the reference.
8. Present the candidate identity, drift summary, dispositions, adaptations, validation evidence, and unresolved risks. Request explicit maintainer confirmation before promotion.
9. Promote that exact candidate only after confirmation. Re-run the contract check and inspect the final diff.

Never auto-promote, silently accept unknown drift, modify the public `figma-workspace` skill solely for maintainer mechanics, or use the snapshot as runtime truth. An unknown or newly discovered official capability defaults to the schema-first public `figma:upstream:list` -> `figma:upstream:read` -> `figma:upstream:call` escape hatch until a separate public-contract decision creates a typed wrapper. `coverage` is advisory only: direct calls to covered official tools remain supported. Keep maintenance commands out of the public `figma:*` surface.
