# Figma Workspace TODO

## Pending: Code Connect response-budget sidecar containment

Status: deferred candidate for a future `0.6.3`-or-later patch. It is not implemented, released, or approved for promotion.

### Risk

`figma:code-connect:inspect`, `plan`, `apply`, and `verify` each process upstream MCP responses through workflow-specific diagnostic and sidecar paths. A response that exceeds the runtime response budget must never cause a complete sanitized payload to be serialized into a Code Connect sidecar. Otherwise the response-size limit can be bypassed through local memory, CPU, and disk work.

### Required behavior

- Read steps (`inspect`, `plan`, and `verify`) fail closed with a bounded resource-limit diagnostic and no complete upstream-response payload sidecar.
- `apply` returns `executionOutcome: not_started` when the failure happens before dispatch.
- If the bulk write was confirmed before local response processing fails, `apply` retains `executionOutcome: succeeded`, reports the bounded local post-processing failure, and never replays the write automatically.
- Reuse the established managed-artifact and response-budget primitives where they preserve these workflow-specific outcome semantics.

### Acceptance evidence

- Focused tests cover over-budget responses for all read steps and both pre-dispatch and post-confirmed-write `apply` states.
- Tests prove that no complete response payload is persisted in a Code Connect sidecar on this failure path.
- Existing plan digest, stale-snapshot, conflict, single-bulk-write, readback, and recovery guarantees remain intact.
- Run the Figma runtime typecheck and focused tests before proposing a version bump, commit, or release.
