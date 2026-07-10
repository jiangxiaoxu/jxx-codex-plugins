---
name: task-memory
description: Maintain durable, workspace-local task state for work that must survive context compaction, interruption, or agent handoff. Use when the user asks to persist, resume, summarize, or durably hand off a task with saved state, or when a long-running investigation or implementation needs durable decisions and evidence across sessions or agents. Do not activate merely because a subagent is used, or for short tasks, validation/build/test-only work, or one-shot commands.
---

# Task Memory

Store each task under `<absolute-workspace>/task-memory/<task-id>/`:

```text
task-memory/<task-id>/
|- task_state.md
|- reports/
`- artifacts/
```

Use a lowercase hyphen-case `task-id` beginning with `task-`; the helper uses it directly.

## Helper

Resolve `<skill-dir>/scripts/task_memory.py` from the directory containing this `SKILL.md`; never use a workspace-relative or hard-coded install/cache path. Verify it before first use. If missing, search only the current skill bundle and report the mismatch. Always pass an absolute `--workspace`.

```text
python <skill-dir>/scripts/task_memory.py init --workspace <workspace> --task-id task-<name>
python <skill-dir>/scripts/task_memory.py status --workspace <workspace> --task-id task-<name>
python <skill-dir>/scripts/task_memory.py create-report --workspace <workspace> --task-id task-<name> --name <report-name>
python <skill-dir>/scripts/task_memory.py delete-report --workspace <workspace> --task-id task-<name> --report <report-filename>
```

For a new task, the task owner runs `init` before substantive work or delegation. Use the printed `task_id`; `init` adds `-001`, `-002`, and so on when needed. Resume an existing task with its assigned id, never another `init`. Run `status` before resume or coordination.

## Ownership

- **Task owner**: The root session. Owns `task_state.md`, lifecycle, report absorption/deletion, and final integration.
- **Report-required handoff**: Owns durable delegated findings or changes in one report; never edits `task_state.md`.
- **Command-only handoff**: Runs an exact command scope and never writes task-memory files.

Only the task owner may run `init`, edit `task_state.md`, absorb reports, or delete reports. Do not infer task-memory ownership when a brief omits the mode. Once a task id is active, use a template below for delegated non-conversational work. This skill governs persistence, not delegation or agent-role choice.

## State

Keep `task_state.md` sufficient to resume without chat history:

```markdown
# Task State
## Goal
## State
## Open
## Reports
```

- `Goal`: Objective and success criteria.
- `State`: Current phase, durable decisions and facts, completed outcomes, and evidence needed to avoid reopening settled questions.
- `Open`: Active blockers, questions, risks, and next actions.
- `Reports`: Finished reports with durable content not yet absorbed; discover live reports with `status` and keep no deleted-report history.

Rewrite current state instead of appending history. Update it only when the objective, a durable decision or fact, scope or contract, blocker or risk, meaningful outcome, or next action changes. Omit commands, searches, attempts, raw output, routine checks, and unchanged progress; record only an actionable issue and stable pointer when a check reveals one.

Use soft budgets of 2-4 bullets in `Goal`, 5-12 in `State`, and 0-5 in `Open`. Merge duplicates, replace obsolete state, and discard reproducible or non-durable detail; never drop resume-critical information to meet a budget. Before implementation, record the selected approach, ownership or contract decisions, blockers, and next actions needed to resume.

## Reports

For a report-required handoff, run `status`, read `task_state.md`, then run `create-report` exactly once before substantive work. Maintain the generated fields:

- `Scope`: Owned assignment and boundaries.
- `Status`: `in-progress`, `completed`, `blocked`, or `stopped`.
- `Last updated`: Time of the latest meaningful change.
- `Conclusion`: 1-2 direct-result bullets.
- `Findings`: 1-5 new durable facts with stable evidence pointers.
- `Open`: 0-3 remaining blockers or next actions.

Omit audit trails, raw output, diffs, repeated searches, reasoning traces, dead ends, and routine validation. Before returning, set a terminal status and return only the report filename plus brief status.

For `completed` or `blocked`, absorb all resume-critical content. For `stopped` or externally terminated work, absorb stable findings and active follow-up and discard unstable partial content. Before deletion, every item must be absorbed into `task_state.md` or intentionally discarded as reproducible or non-durable. Delete only with the helper.

## Artifacts

Store task-created scratch files, downloads, captures, and intermediate assets in `artifacts/` unless the user, task, tool, or project requires another path. Keep normal build, test, cache, coverage, and repository-tool outputs in their normal locations.

## Resume

Run `status`, read `task_state.md`, inspect live report statuses and pending report notes, reconcile terminal reports, then continue from current state. For summary or compaction, reconcile first and rewrite current state; preserve active decisions, work, blockers, next actions, and hard evidence pointers.

## Handoff Templates

Report-required:

```text
Use $task-memory for a Report-required handoff. Task memory: task-id=task-<name>; report name=<report-name>.
Run `status`, read `task_state.md`, then run `create-report` before substantive work. Set `Scope` to <assignment and boundaries>; keep `Status`, `Last updated`, and the generated headings current. Do not edit `task_state.md`.
Before returning, set `Status: completed`, `blocked`, or `stopped`. Return only the report filename plus brief status; put durable findings and blockers in the report.
```

Command-only:

```text
Use $task-memory for a Command-only handoff. Task memory: task-id=task-<name>.
Run only <exact command or command family>. Expected result: <pass/fail shape, exit code when available, and shortest useful error signature>.
Do not run `create-report` or write task-memory files. Return only the requested result.
```
