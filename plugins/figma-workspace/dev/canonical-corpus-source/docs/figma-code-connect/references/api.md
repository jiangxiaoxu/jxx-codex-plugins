# Code Connect Workflow Reference

Code Connect operations are exposed through four public commands. They use the live upstream contract internally and keep upstream operation names out of the agent-facing interface.

## Commands

| Command | Purpose | Mutation |
| --- | --- | --- |
| `figma:code-connect:inspect --file <Design URL|fileKey>` | Discover components available for mapping. | No |
| `figma:code-connect:plan --file <Design URL|fileKey> --input <manifest.json|->` | Validate input, read context/suggestions and current mappings, then write an immutable plan. | No |
| `figma:code-connect:apply --file <Design URL|fileKey> --plan <path> --confirm-plan <digest>` | Revalidate the snapshot, bulk-write create/replace actions, and read back every mapping. | Yes |
| `figma:code-connect:verify --file <Design URL|fileKey> --plan <path>` | Compare the plan mappings with current remote state. | No |

All commands require a Design target. A URL is preferred; a raw file key is accepted by command help. Every invocation is stateless.

## Mapping model

The supported mapping fields are `nodeId`, `componentName`, `source`, `label`, and optional `conflictPolicy` (`fail` or `replace`). A mapping is identified by `(nodeId, label)`. Readback compares all four value fields. Templates and `templateDataJson` are intentionally unsupported because they cannot be safely compared by this workflow.

The manifest has `schemaVersion: 1`, a required `scope.nodeId`, optional string `client.languages` and `client.frameworks`, and 1 to 64 mappings. Unknown fields and duplicate identities fail validation. Labels are checked against the live Code Connect label enum rather than a hard-coded list.

## Plans and outcomes

The plan records the normalized Design target, manifest fingerprint, current mapping fingerprints, actions, and a SHA-256 `planDigest`. `apply` requires a present, exact digest match and a matching `--file`; a missing or mismatched confirmation returns `executionOutcome: not_started` before dispatch. Before dispatch it reads every mapping again; any changed, unavailable, or untrusted value makes the plan stale and returns `executionOutcome: not_started`.

Only `create` and explicitly authorized `replace` actions are sent, in one bulk request. `noop` actions are not sent. A timeout, response loss, or remote error after dispatch is `outcome_unknown`; run `verify` and reconcile before deciding whether another plan is needed. A confirmed write followed by readback failure remains `succeeded` and must not be replayed blindly.

## Boundaries

This workflow does not scan a code repository, inspect source files, generate template artifacts, or execute Plugin API code. Use `figma:run` for separate canvas work. For official capabilities not covered by these commands, inspect the live schema and use the generic `figma:upstream:list` -> `figma:upstream:read` -> `figma:upstream:call` path.
