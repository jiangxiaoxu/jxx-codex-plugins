---
name: task-memory
description: Create, resume, and maintain lightweight task memory for long-running Codex or AI agent work. Use when a task needs durable state across context compaction, handoffs, resumes, repeated exploration, or subagent delegation; when root should keep task_state.md current; or when a subagent should read task_state.md, run status/create-report, write a report into reports/, and return the report path. Root absorbs and deletes reports after full absorption.
---

# Task Memory

Use this skill to keep long tasks recoverable without treating chat history as the source of truth.

Task memory lives under the absolute workspace path passed to `--workspace`; use the current project/workspace root unless the user specifies another location. Identify each task with a workspace-unique `task-id`, such as `agent-memory` or `thumbnail-validation`.

```text
task-<task-id>/
  task_state.md
  reports/
```

## Core Protocol

Root owns `task_state.md`.

Root updates `task_state.md` directly whenever durable task memory changes: goal or scope changes, stable decisions, completed root work, important evidence, validation results, blockers, open questions, and absorbed subagent reports.

Do not route root's own work through `reports/` unless the user explicitly asks for a handoff or audit artifact.

Subagents never edit `task_state.md`. They activate/read this skill first, run `status`, read `task_state.md`, do the assigned work, create one report in `reports/`, write the report, and return the report path to root.

Reports are temporary inbox items. After root fully absorbs a report into `task_state.md`, root deletes the report file. Keep only a short absorbed-report note in `task_state.md`. Full absorption means the task can resume from `task_state.md` without reopening or regenerating the report for the same decision.

Before dispatching any subagent:

1. Update `task_state.md` with the latest goal, state, open items, and pending reports.
2. Explicitly activate this skill for the subagent with `Use $task-memory` at the start of the brief, and pass the skill as a structured skill item when the tool supports it.
3. Include the absolute workspace path, `task-id`, and suggested report name in the subagent brief.
4. Tell the subagent to run `status`, read `task_state.md`, run `create-report`, write the generated report, and return the report path.
5. Tell the subagent not to modify `task_state.md`.

After a subagent finishes:

1. Read the report from `reports/` in full. Do not rely only on returned key points.
2. Absorb durable content into `task_state.md` using the absorption rules below.
3. If anything remains unabsorbed, keep the report in `reports/` and add a short `Reports > Pending` note explaining what remains.
4. When absorption is complete, add one short `Reports > Absorbed` entry with the report filename, headline conclusion, and where the durable content was absorbed in `State`.
5. Delete only a fully absorbed report. Do not delete a report merely because its headline conclusion was copied.

## Absorption Rules

Keep `task_state.md` compact, but preserve enough hard pointers and findings to prevent repeated exploration after context compaction. Preserve one durable evidence item per independent subsystem, decision, risk, or validation result; combine related pointers when possible, but do not drop hard evidence only to keep the entry short.

When absorbing a report, preserve durable items from `Evidence`, `Data or Control Flow`, `Validation`, `Open Risks`, and `Suggested Task State Update`:

- Stable conclusion, decision, or failure status.
- Exact evidence pointers: `path:line-line`, symbol/function/class names, config keys, query names, API fields, command names, test names, source URLs, or error signatures.
- Data flow, control flow, dependency chain, or ownership boundary when the conclusion depends on behavior across components.
- Validation command or method, result, and scope: full validation, scoped validation, probe only, or not checked.
- Remaining uncertainty, risk, blocker, and next action.

Move remaining risks, blockers, uncertainties, and next actions into `Open`.

Before deleting a report, each durable item must be represented in `task_state.md`, intentionally discarded as non-durable, or left unabsorbed with the report still pending. If an item looks like durable evidence but is intentionally discarded, note the reason briefly in the absorbed report note or `Open`. Usually discard raw stdout, large diffs, repetitive search output, dead-end exploration, abandoned hypotheses, and duplicate evidence after their durable conclusion has been captured.

A report is adequately absorbed only when another agent can continue from `task_state.md` without reopening or regenerating that report for the same decision.

## Report Shape

Ask subagents to write concise reports that are easy to absorb. Use `None`, `N/A`, or `Not checked` when a section does not apply. For implementation reports, include changed file paths under `Evidence` and validation under `Validation`.

````markdown
# <Report Title>

Created: <timestamp>
Task state read: <absolute task_state.md path>
Scope: <assigned subtask and explicit boundaries>
Repo/context snapshot: <commit, branch, timestamp, or "not checked">

## Conclusion

- <Direct answer, decision, or failure status.>

## Evidence

- `<path:line-line>` `<symbol/config/API/test/command>` - <fact supported by this pointer>.
- `<path>` `<symbol>` - <fact supported by this pointer when line numbers are unavailable>.

## Data or Control Flow

- <Only include for behavior tracing, routing, ownership, update logic, or dependencies. Name concrete nodes and edges. Use `None` if not applicable.>

## Validation

- `<command or method>` - <pass/fail/not run>; scope: <full/scoped/probe only/not checked>; relevant output or error signature: <short exact signature or None>.

## Open Risks

- <Remaining uncertainty, blocker, or condition that would change the conclusion. Use `None` if closed.>

## Suggested Task State Update

- <Compact durable finding with inline evidence pointer and validation/risk when relevant. Do not write headline-only bullets that require this report to remain available.>
````

## Task State Shape

Keep `task_state.md` compact and current. Do not use it as a log dump.

Use these sections:

```markdown
# Task State

## Goal

## State

## Open

## Reports
```

`Goal` stores the objective and success criteria. `State` stores current phase, durable understanding, completed work, confirmed decisions, validation status, and high-signal evidence. `Open` stores unresolved questions, blockers, and next subagent-ready gaps. `Reports` stores pending report notes and one-line absorbed report notes.

Within `State`, prefer this compact shape when the task has evidence-bearing findings. When absorbing an evidence-bearing report, include at least one durable finding, evidence ledger item, or validation item unless the report only confirms no durable change:

```markdown
- Current phase: <phase>
- Durable findings:
  - <finding or decision> - evidence: `<path:line-line>` `<symbol/test/command>`; validation: <full/scoped/probe/not checked>.
- Evidence ledger:
  - `<short label>`: `<path:line-line>` `<symbol/config/API/test/command>` - <fact this pointer supports>.
- Validation:
  - `<command or method>` - <pass/fail>; scope: <full/scoped/probe/not checked>; notes: <short exact error signature or None>.
```

Omit empty nested labels when they do not add value.

## Resume Protocol

After context compaction, handoff, or a long pause, root must treat `task_state.md` as the source of truth.

1. Run `status` for the workspace and task-id.
2. Read `task_state.md`.
3. Check pending reports listed by `status` and under `Reports`.
4. Absorb or explicitly leave pending any report that overlaps with the next planned work.
5. Continue from `Goal`, `State`, `Open`, and pending report notes, not from chat history alone.

## Scripts

Use bundled scripts for the mechanical parts of the workflow.

```bash
python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
python scripts/task_memory.py delete-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
```

`status` has no side effects. It prints `task_dir`, `task_state`, `reports_dir`, `pending_reports`, and any existing `pending_report` paths.

`create-report` creates a report template and prints its absolute path. The `--name` value should be a short hyphen-case or quoted English phrase and is normalized to lowercase hyphen-case.

`delete-report` deletes an already absorbed report and does not edit `task_state.md`. Root must absorb the report manually before deletion.

Only root may run `delete-report`. Subagents must never delete reports. Delete reports one filename at a time using the script; do not use shell `rm`, wildcards, or directory deletion for report cleanup.

Always pass an absolute path to `--workspace`. The script can resolve relative paths, but absolute paths are more reliable across subagents, handoffs, and context compaction.

## Brief Template

Use this shape when dispatching a subagent:

```text
Use $task-memory for this subtask. Follow the subagent protocol in that skill.

Task memory:
- workspace: <absolute workspace path>
- task-id: <task-id>
- report name: <short report name>

Start by running:
python scripts/task_memory.py status --workspace <absolute workspace path> --task-id <task-id>

Then read the returned task_state path.

Before writing your findings, create your report by running:
python scripts/task_memory.py create-report --workspace <absolute workspace path> --task-id <task-id> --name <short report name>

Write your report to the generated report path.

Task:
<specific assignment>

Constraints:
- Do not modify task_state.md.
- Do not modify source files unless explicitly assigned.
- Use the Report Shape from $task-memory.
- Keep the report concise and evidence-based.
- The returned 3-5 key points are only a preview; the report file is the durable handoff artifact.
- Fill `Scope` with the assigned subtask and explicit boundaries.
- Include exact evidence pointers and validation scope.
- In Suggested Task State Update, include inline evidence pointers so root can absorb it after deleting the report.
- For flow investigations, name concrete nodes and edges.
- Return only the report path and 3-5 key points.
```
