---
name: task-memory
description: Maintain durable, workspace-local task state that survives context compaction, interruption, or later resume. Use when the user explicitly asks to persist or resume task state or when a long-running task needs a resumable checkpoint. Do not activate for ordinary summaries, ordinary subagent work, short tasks, validation/build/test-only work, or one-shot commands.
---

# Task Memory

Store each task under `<absolute-workspace>/task-memory/<task-id>/`:

```text
task-memory/<task-id>/
|- task_state.md
`- artifacts/
```

Use a `task-id` beginning with `task-`; the CLI normalizes it to lowercase hyphen-case.

## CLI

Resolve `<plugin-root>` as `<skill-dir>/../..`, where `<skill-dir>` contains this `SKILL.md`, and use it as the working directory. Verify `package.json` before first use; never use a workspace-relative or hard-coded install/cache path. Use `npm --silent` so npm lifecycle banners do not contaminate stdout, put npm's `--` separator before CLI arguments, and always pass an absolute `--workspace`. Run the selected entrypoint with `--help` before first use.

```text
npm --silent run task-memory:init -- --workspace <workspace> --task-id task-<name>
npm --silent run task-memory:status -- --workspace <workspace> --task-id task-<name>
```

For a new task, `/root` runs `init` and uses the printed `task_id`; `init` adds `-001`, `-002`, and so on when needed. Resume an existing task with its assigned id. Run `status` before resume to validate the layout and obtain the canonical state and artifacts paths.

## Ownership

`/root` owns initialization, `task_state.md`, summaries, and final integration. Child agents return through the normal agent channel and do not write task-memory files unless `/root` assigns a specific artifact path required by the task.

This contract does not decide whether to delegate, which agent role to use, or how to split or parallelize work.

## State

Keep `task_state.md` sufficient to resume without chat history:

```markdown
# Task State
## Goal
## State
## Open
```

- `Goal`: Objective and success criteria.
- `State`: Current phase, durable decisions and facts, completed outcomes, and evidence that prevents reopening settled questions.
- `Open`: Active blockers, questions, risks, and next actions.

Rewrite current state instead of appending history. Update it only when the objective, durable decision or fact, scope or contract, blocker or risk, meaningful outcome, or next action changes. Omit commands, searches, attempts, raw output, routine progress, and obsolete history.

Record the shortest validation conclusion only when it is bound to the current revision or diff and is needed to determine completion or resume safely. Keep the check name, pass/fail result, and shortest useful failure signature; omit command ledgers and raw output.

Use soft budgets of 2-4 bullets in `Goal`, 5-12 in `State`, and 0-5 in `Open`. Merge duplicates and discard reproducible or non-durable detail, but never drop resume-critical information to meet a budget.

## Artifacts And Resume

Store task-created scratch files, downloads, captures, and intermediate assets in `artifacts/` unless the user, task, tool, or project requires another path. Keep normal build, test, cache, coverage, and repository-tool outputs in their normal locations.

To resume, run `status`, read `task_state.md`, then continue from `Goal`, `State`, and `Open`. For a summary or compaction checkpoint, rewrite the current state first.
