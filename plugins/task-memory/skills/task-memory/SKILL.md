---
name: task-memory
description: Maintain durable, workspace-local task state that survives context compaction, interruption, or later resume. Use when the user explicitly asks to persist or resume task state, when a long-running task needs a resumable checkpoint, or when a /root dispatch explicitly invokes $task-memory with a task-id and report-name for one durable report. Do not activate for ordinary summaries, ordinary subagent work, short tasks, validation/build/test-only work, or one-shot commands.
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

For a new task, `/root` runs `init` and uses the printed `task_id`; `init` adds `-001`, `-002`, and so on when needed. Resume an existing task with its assigned id. Run `status` before resume or report reconciliation.

## Write Contract

- `/root` owns `task_state.md`, initialization, report reconciliation and deletion, summaries, and final integration.
- A durable report writer is a child whose dispatch explicitly includes `$task-memory`, `task-id`, and `report-name`. It reads `task_state.md`, creates exactly one report before substantive work, edits only that report, and never edits `task_state.md`.
- Other children do not use this skill or write task-memory files; they return through the normal agent channel.

This contract does not decide whether to delegate, which agent role to use, or how to split or parallelize work. `/root` chooses whether a child result needs a durable report.

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
- `State`: Current phase, durable decisions and facts, completed outcomes, and evidence that prevents reopening settled questions.
- `Open`: Active blockers, questions, risks, and next actions.
- `Reports`: Live reports whose durable content has not been reconciled.

Rewrite current state instead of appending history. Update it only when the objective, durable decision or fact, scope or contract, blocker or risk, meaningful outcome, or next action changes. Omit commands, searches, attempts, raw output, routine progress, and obsolete history.

Record the shortest validation conclusion only when it is bound to the current revision or diff and is needed to determine completion or resume safely. Keep the check name, pass/fail result, and shortest useful failure signature; omit command ledgers and raw output.

Use soft budgets of 2-4 bullets in `Goal`, 5-12 in `State`, and 0-5 in `Open`. Merge duplicates and discard reproducible or non-durable detail, but never drop resume-critical information to meet a budget.

## Durable Reports

A durable report writer runs `status`, reads `task_state.md`, then runs `create-report` once. Keep the generated `Scope`, `Status`, `Last updated`, `Conclusion`, `Findings`, and `Open` fields current. Use `Status: in-progress`, `completed`, `blocked`, or `stopped`; keep conclusions and evidence pointers compact and omit audit trails, raw output, diffs, repeated searches, reasoning traces, and routine validation.

Before returning, the writer sets the most accurate status and returns the report filename plus a brief status. `/root` reconciles resume-critical content into `task_state.md` or intentionally discards reproducible or non-durable content, then may delete the report with the helper. Deleting an `in-progress` report is allowed; `/root` must first ensure no active writer will continue writing it.

Use this dispatch contract only when `/root` wants a durable report:

```text
Use $task-memory in durable-report mode. Task memory: task-id=task-<name>; report-name=<report-name>.
Run status, read task_state.md, then create one report before substantive work. Write only that report; do not edit task_state.md. Before returning, set the most accurate Status and return the report filename plus brief status.
```

## Artifacts And Resume

Store task-created scratch files, downloads, captures, and intermediate assets in `artifacts/` unless the user, task, tool, or project requires another path. Keep normal build, test, cache, coverage, and repository-tool outputs in their normal locations.

To resume, run `status`, read `task_state.md`, inspect live reports, reconcile reports that are ready, then continue from `Goal`, `State`, and `Open`. For a summary or compaction checkpoint, reconcile first and rewrite the current state.
