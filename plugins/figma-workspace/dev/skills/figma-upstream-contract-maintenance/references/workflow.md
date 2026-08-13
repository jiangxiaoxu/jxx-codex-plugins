# Upstream Contract Adaptation Workflow

## Invariants

- Treat the committed snapshot as the last reviewed and supported upstream baseline.
- Treat a captured candidate and its report as review evidence, not as accepted state.
- Keep candidates in the CLI-owned ignored candidate directory. Do not hand-edit candidate snapshots or reports.
- Use the command `--help` as the source of truth for current flags and result fields.
- Keep the public CLI contract in typed source, metadata, generated help, runtime behavior, and tests. Do not derive runtime behavior from a committed snapshot.
- Promotion replaces only the local accepted contract fixture after adaptation. It records a reviewed live-schema baseline; it does not generate agent-facing help, add a public command, or modify the remote MCP or GitHub upstream guide archive.
- Contract evidence can retain upstream annotations and protocol `_meta` for drift review. Agent-facing discovery, results, and sanitized sidecars must omit both; do not remove an ordinary business `_meta` nested inside `structuredContent`.
- Do not modify `plugins/figma-workspace/skills/figma-workspace` for maintainer-only mechanics.
- Do not promote when the baseline changed after capture, validation failed, blocking drift remains unresolved, or the maintainer has not explicitly confirmed the exact candidate.

## 1. Establish the Baseline

From the repository root, inspect `git status --short` for the candidate area, committed snapshot, CLI source, tests, and generated output. Record pre-existing changes and do not stage, revert, or overwrite them.

From `plugins/figma-workspace/cli-runtime`, inspect the available maintenance commands:

```text
npm run upstream:contract:capture -- --help
npm run upstream:contract:report -- --help
npm run upstream:contract:check -- --help
npm run upstream:contract:promote -- --help
```

Use the command-defined candidate identifier and paths. If a command is missing or its contract differs, stop and repair or clarify the maintenance CLI before continuing; do not substitute direct snapshot edits.

## 2. Capture a Candidate

Run `npm run upstream:contract:capture` with the required live upstream configuration. Capture must:

- read the official live MCP contract through all cursor pages under one five-minute deadline, with a 100-page maximum and no partial capture;
- normalize ordering deterministically;
- record the committed baseline hash and capture metadata;
- write only candidate artifacts;
- leave the committed snapshot unchanged.

Retain the returned candidate identifier. Generate the report with `npm run upstream:contract:report` for that exact candidate if capture does not already produce it.

## 3. Classify Semantic Drift

Match stable identities before comparing fields:

| Surface | Stable identity |
| --- | --- |
| Tool | `name` |
| Resource | `uri` |
| Resource template | `uriTemplate` |

Classify each change and record its disposition:

| Class | Default disposition |
| --- | --- |
| Added tool, resource, or template | Review ownership and exposure; do not expose automatically. |
| Removed or renamed tool | Blocking when any wrapper, runtime path, help entry, test, or documentation depends on it. |
| Required property added or removed | Blocking; update parsing, invocation, error behavior, help, and tests. |
| Optional property added | Review whether the public wrapper should expose it; omission requires an intentional disposition. |
| Property removed | Remove public passthrough and stale diagnostics when it has no remaining behavior; update tests. |
| Type, enum, default, constraint, or result-shape change | Blocking until behavior and compatibility impact are understood and tested. |
| Description-only change | Non-blocking only after confirming it carries no semantic requirement. |
| Resource content change | Review for operational or policy impact; do not treat index movement as content drift. |
| Ordering-only or normalization-only change | Non-semantic; verify normalization before dismissing. |
| Unclassified change | Blocking pending maintainer judgment. |

For each affected wrapper, compare upstream input and result schemas with the public contract, CLI metadata/help, invocation builder, diagnostic behavior, and focused tests. Remove unsupported logging-only passthrough fields instead of preserving compatibility shims.

Create a machine-readable disposition file using the exact `changeId` values from the report. Every change requires one supported disposition and a non-empty rationale:

- `adapted-wrapper`: local contracts, runtime, help, and tests now implement the change;
- `intentionally-unexposed`: the upstream capability or field remains outside the public CLI by explicit decision;
- `accepted-upstream`: the change needs no local behavior change and has been reviewed as accepted evidence.

Regenerate the report with `npm run upstream:contract:report -- --candidate <candidate-id> --disposition-file <path>` and re-read it. Unknown, duplicate, stale, or missing `changeId` entries must fail closed.

## 4. Adapt the CLI

Edit only the canonical owners identified by `doc/figma-workspace-ai-agent-development.md`. Update typed schemas and metadata before concise summaries. Keep first-class wrappers intentional: an unknown or newly discovered upstream capability defaults to the schema-first public `figma:upstream:list` -> `figma:upstream:read` -> `figma:upstream:call` escape hatch and is not automatically a new public command. `coverage` can identify a typed alternative but must not block a covered direct call. Promote a capability to a typed wrapper only after a separate public-contract decision; removed or changed upstream fields must not remain falsely advertised.

Add focused coverage for each resolved drift category, including negative cases for removed fields and fail-closed behavior for incompatible required or type changes. Rebuild checked-in generated output only through the owning build command.

Do not promote merely to make drift tests pass. The candidate must continue to compare against the old accepted baseline throughout adaptation.

## 5. Validate Before Acceptance

Run focused tests for changed owners, then from `plugins/figma-workspace/cli-runtime` run:

```text
npm run typecheck
npm test
npm run upstream:contract:check -- <candidate arguments from --help>
```

Run `npm run check:dist` only when its clean-worktree precondition is satisfied. If changes affect plugin-root behavior or generated corpus, also run the owning plugin-root validation. Finish with `git diff --check`.

Before requesting promotion, report:

- candidate identifier and captured baseline hash;
- semantic drift counts and affected stable identities;
- disposition for every blocking or intentionally unexposed change;
- source and test adaptations;
- exact validation commands and outcomes;
- unresolved risks, live verification gaps, and unrelated worktree changes.

## 6. Confirm and Promote

Ask the maintainer to confirm promotion of the exact candidate identifier. A general request to investigate or adapt upstream drift is not promotion authorization.

After confirmation, run `npm run upstream:contract:promote` with that candidate. Promotion must fail closed if the current committed baseline hash differs from the hash recorded at capture, candidate or report integrity fails, any drift lacks a valid disposition, or wrapper coverage remains inconsistent. The accepted fixture's SHA-256 is expected to change; that is not an upstream documentation update.

Promotion verifies contract evidence and publication safety; it does not attest that repository tests were run. Validation evidence remains a maintainer review requirement and must be reported before requesting promotion.

After promotion:

1. Re-run `npm run upstream:contract:check` against the committed baseline.
2. Inspect the committed snapshot diff for deterministic ordering and expected semantic changes.
3. Re-run `git diff --check`.
4. Report the promoted candidate and any remaining non-blocking follow-up. Do not stage or commit unless explicitly requested.

## Recovery

- **Capture or authentication failure:** Keep the accepted baseline unchanged. Diagnose OAuth, network, or live MCP availability and retry capture; do not manufacture a candidate.
- **Malformed or incomplete candidate:** Discard it only through the CLI's safe candidate cleanup behavior, if provided, or leave it isolated and create a new candidate. Never repair evidence by hand.
- **Baseline changed after capture:** Do not promote. Capture a new candidate from the new baseline, regenerate the report, and re-evaluate adaptations.
- **Adaptation or validation failure:** Preserve the candidate for diagnosis, fix the owning source or tests, and repeat validation. Do not weaken the drift gate or update the baseline to hide the failure.
- **Unexpected drift during final check:** Treat it as a new upstream state. Capture another candidate rather than combining two upstream observations.
- **Promotion interruption:** Inspect the committed snapshot and candidate manifest before retrying. Require either the old complete snapshot or the exact complete candidate; do not accept a partial or mixed baseline.
- **Conflicting worktree changes:** Stop before overwrite or promotion and ask the owner how to proceed. Never revert or stage unrelated changes.
