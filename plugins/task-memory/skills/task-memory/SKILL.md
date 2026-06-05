---
name: task-memory
description: Maintain durable task_state.md memory for task-state owners, report handoffs, command-only handoffs, and delegated worker handoffs. Use when Codex needs to create, resume, update, or summarize task state; dispatch scoped work with task-id context; or handle nested task-memory subagent reports.
---

# Task Memory

Use this skill to keep long tasks recoverable without relying on chat history as source of truth.

Task memory lives under `--workspace`, normally the current workspace root, as `task-memory/task-<task-id>/task_state.md` plus `reports/archive/`.

`init` creates the `task-memory/` parent folder plus `task-<task-id>` or the next `-001`, `-002`, etc. variant under it, then prints `task_id=<actual-task-id>`. Use the actual task id thereafter.

For compatibility, existing legacy memory at `--workspace/task-<task-id>/` is still readable by `status`, `create-report`, and `archive-report` when no matching new-layout task exists. New-layout memory is canonical and wins if both locations exist. New tasks are always created under `--workspace/task-memory/`. Legacy fallback is controlled by `ENABLE_LEGACY_TASK_DIR_COMPAT` in `scripts/task_memory.py` so it can be disabled in one place.

## Role Routing

On activation, first route by agent role and handoff mode:

- Task-state owner: usually `/root`; owns `task_state.md`, updates durable state, dispatches or receives handoffs, absorbs reports, archives absorbed reports, and performs final integration.
- Dispatching agent: any agent allowed to delegate child work; passes `$task-memory`, `task-id`, handoff mode, and task-local context to child workers without modifying `task_state.md` unless it is also the task-state owner.
- Report-required subagent: activate/read `$task-memory`, run `status`, read `task_state.md`, create exactly one report, write findings there, and return only the report path plus one high-level summary sentence to the direct parent.
- Command-only subagent: activate/read `$task-memory`, run `status` and read `task_state.md` only when task context is needed, never run `create-report`, never write a report, and return command results in chat.

## Dispatcher Worker Delegation

When an agent activates `$task-memory` and is allowed to dispatch child work, keep the parent context small by preferring worker handoffs for implementation work with a clear write scope, substantial file-reading needs, or details that can be recovered from `task_state.md` plus the parent brief.

Before the task-state owner dispatches a worker, it updates `task_state.md` with current goal, scope, decisions, constraints, open questions, and any pending report context the worker needs. A non-owner dispatcher does not edit `task_state.md`; it adds only task-local context, write scope, constraints, and expected return details to the child brief.

Use a worker handoff when the worker can start from `task_state.md`, combine it with the direct parent brief, implement within explicit boundaries, and return durable findings through a report. The task-state owner keeps ownership of `task_state.md`, report absorption, archive decisions, final integration, and cross-worker conflict resolution. A nested worker returns its report to the direct parent; that parent incorporates durable child findings into its own report, and the task-state owner later absorbs them into `task_state.md`.

## Core Protocol

The task-state owner owns `task_state.md` and updates it for durable goal/scope changes, decisions, completed owner work, important evidence, decision-bearing validation, blockers, open questions, and absorbed reports. Do not route the task-state owner's own work through `reports/` unless the user asks for a handoff or audit artifact.

Treat routine validation, review, and state-check results as non-durable by default. Record final/representative validation, failures, blockers, unresolved risks, next-step-changing not-run validation, unexpected side effects, and requested audit facts. Do not record intermediate passing validation, routine output, raw stdout, repeated command history, or local inspection details. When recording, keep one short conclusion plus the smallest useful pointer, command, affected-file summary, or error signature; merge repeats.

## Handoffs

Non-owner subagents never edit `task_state.md`.

Dispatch contract:

- A dispatching agent must explicitly choose `Report-required` or `Command-only` before delegating any work that should use task memory, and must include the matching canonical brief below. Do not rely on a partial paraphrase.
- Every task-memory handoff brief must include `Use $task-memory`, `task-id`, and the mode-specific constraints. Report-required briefs must also include a report name.
- Do not make the dispatching agent repeat the skill file, task memory script path, or workspace in normal handoffs. Subagents activate/read `$task-memory`, resolve bundled scripts from the skill, and use the current workspace unless the brief explicitly states otherwise.
- If a subagent brief includes `Use $task-memory` plus `task-id`, the subagent must activate/read `$task-memory` and follow the matching handoff mode.
- If the brief omits the handoff mode, classify by task shape: exploration, implementation, impact analysis, call tracing, decision support, durable evidence collection, or results that should survive compaction are `Report-required`; parent-specified command execution is `Command-only`.

Choose handoff mode by task shape:

- Report-required: exploration, implementation, impact analysis, call tracing, decision support, durable evidence collection, or results that should survive compaction as independent evidence.
- Command-only: parent-specified command execution returning command, cwd, pass/fail, exit code, scoped output, or short error signatures without independent exploration, implementation, or durable analysis.

For implementation, prefer a worker handoff when the write scope and validation boundary can be stated clearly. Keep the work in the current parent only for very small edits, state/report absorption, final integration, or tasks that require immediate parent decisions while editing.

Report-required flow:

1. The task-state owner updates `task_state.md` with latest goal, state, open items, and pending reports before dispatching. A non-owner dispatcher adds only task-local context to the child brief.
2. The dispatching agent briefs the subagent with `Use $task-memory`, `task-id`, report name, status/create-report steps, return format, and `Do not modify task_state.md`.
3. Subagent activates/reads this skill, runs `status`, reads `task_state.md`, creates exactly one report, does the work, writes findings, and returns only the report path plus one high-level summary sentence to the direct parent.
4. The direct parent reads the report in full. If the direct parent is not the task-state owner, it incorporates durable child findings into its own report; the task-state owner later absorbs durable content into `task_state.md` and archives only when fully absorbed.

Do not add `Reports > Pending` when dispatching or running `create-report`; `status` tracks live unarchived reports. Add Pending only after the task-state owner reads a finished report and durable content remains unabsorbed. When absorption completes, remove matching Pending, add one `Reports > Absorbed` note with filename, conclusion, and `State` location, then archive.

Command-only handoffs may run `status` only if task context is needed. They do not run `create-report`, do not write reports, and return results in chat. Command-only activation never implies report creation; unless the brief explicitly selects `Report-required`, do not run `create-report` or write a report. The task-state owner applies the validation/state-check rules before writing any command result to `task_state.md`; do not create synthetic absorbed-report notes.

Archived reports are best-effort audit copies, not durable state. Preserve resume-critical content in `task_state.md` before archiving; do not rely on archived reports.

## Absorption Rules

Keep `task_state.md` compact but sufficient to prevent repeated exploration after compaction. Preserve one durable evidence item per independent subsystem, decision, risk, or decision-bearing validation.

When absorbing a report, use `Conclusion`, `Absorbable Findings`, and `Open or Not Checked`. Preserve stable conclusions, decisions, risks, failure/validation status, exact evidence pointers (`path:line-line`, symbols, config keys, API fields, commands/tests, source URLs, error signatures), one short anti-reopen fact, and remaining uncertainty/blockers/next actions. Move active risks, blockers, uncertainties, and next actions into `Open`.

Before archiving, each durable item must be in `task_state.md`, intentionally discarded as non-durable, or left pending. If durable-looking evidence is discarded, briefly note why. Usually discard raw stdout, large diffs, routine review/state-check output, repeated command/search output, inspection output, reasoning traces, dead ends, abandoned hypotheses, and duplicate evidence after capturing the conclusion.

A report is absorbed only when another agent can continue from `task_state.md` without reopening or regenerating it for the same decision.

## Report Shape

Ask subagents for absorption-ready summaries, not audit logs. Use `None`, `N/A`, or `Not checked` when a section does not apply. Prefer 1-5 high-signal bullets. Each absorbable finding should be copyable or easy to condense; evidence starts with a hard pointer plus at most one short fact. Exclude raw stdout, large diffs, routine/static-check detail, search/inspection output, reasoning, dead ends, duplicates, and unlikely-to-absorb information.

````markdown
# <Report Title>
Created: <timestamp>
Task state read: <absolute task_state.md path>
Scope: <assigned subtask and explicit boundaries>
Repo/context snapshot: <commit, branch, timestamp, or "not checked">
## Conclusion
- <1-2 bullets with the direct answer, decision, or failure status.>
## Absorbable Findings
- <Finding, decision, risk, failure status, or decision-bearing validation result.> Evidence: `<path:line-line>` `<symbol/config/API/test/command>` - <one short fact>.
- <Another finding, or `None` if no durable finding should be absorbed.> Evidence: `<command/test/error signature>` - <one short fact or `not checked`>.
## Open or Not Checked
- <0-3 bullets with blockers, unresolved questions, not-run validation, or next actions that change what the direct parent or task-state owner should do. Use `None` if closed.>
````

## Task State Shape

Keep `task_state.md` compact and current; do not use it as a log dump.

```markdown
# Task State
## Goal
## State
## Open
## Reports
```

`Goal` stores objective and success criteria. `State` stores phase, durable understanding, completed work, decisions, acceptance validation, and high-signal evidence. `Open` stores unresolved questions, blockers, and next subagent-ready gaps. `Reports` stores Pending and Absorbed notes; Pending notes include filename/reason, Absorbed notes include filename, conclusion, and `State` location.

For evidence-bearing tasks, prefer this compact `State` shape and omit empty nested labels:

```markdown
- Current phase: <phase>
- Durable findings:
  - <finding or decision> - evidence: `<path:line-line>` `<symbol/test/command>`; validation: <full/scoped/probe/not checked>.
- Evidence ledger:
  - `<short label>`: `<path:line-line>` `<symbol/config/API/test/command>` - <fact this pointer supports>.
- Validation:
  - `<command or method>` - <pass/fail>; scope: <full/scoped/probe/not checked>; notes: <short error signature, blocker, or None>.
```

Use `Validation` for acceptance-relevant checks. Do not record routine review/state-check commands or intermediate passing validation unless they expose a failure, blocker, open risk, unexpected side effect, or requested audit fact.

## Summary Protocol

Use when the user asks to summarize, compact, or clean up `task_state.md`. Summary is a task-state-owner rewrite, not a report workflow; do not create a report or read archived reports for normal summary.

Before rewriting, run `status`, read `task_state.md`, and check pending reports. Absorb overlapping pending reports or explicitly leave them pending. Ask for options before modifying unless already provided; prefer `request_user_input`:

- Summary level: `Balanced` (recommended: compact low-value detail; keep active decisions/evidence/validation/open work), `Conservative`, or `Aggressive`.
- Evidence retention: `Hard pointers` (recommended: one pointer per active decision/risk/decision-bearing validation/subsystem finding), `Decision focused`, or `Minimal`.
- History handling: `Collapse absorbed notes` (recommended), `Keep timeline`, or `Current state only`.

When applying a summary, preserve `# Task State`, `Goal`, `State`, `Open`, and `Reports`. The result must support resume without chat history, archived reports, or reopening absorbed reports. Do not discard blockers, pending notes, active next actions, validation failures, final acceptance status, unexpected side effects, or evidence for open decisions. Remove routine validation/review/state-check history unless audit was requested.

## Resume Protocol

After compaction, handoff, or long pause, the task-state owner treats `task_state.md` as source of truth:

1. Run `status` for workspace and task-id.
2. Read `task_state.md`.
3. Check pending reports from `status` and `Reports`.
4. Absorb or explicitly leave pending any report overlapping the next work.
5. Continue from `Goal`, `State`, `Open`, and pending report notes, not chat history alone.

Archived reports are audit history only; do not read or depend on them during normal resume.

## Scripts

Use bundled scripts for mechanical steps. Resolve `scripts/task_memory.py` relative to the absolute path of this `SKILL.md`, or call `task_memory.py` by its absolute path. Run `init` only for a new task; for existing memory, run `status` with the actual task-id. Always pass an absolute `--workspace`; the script stores new memory under `--workspace/task-memory/`.

Do not expose script paths or workspace arguments in normal subagent briefs. After a subagent activates `$task-memory`, it resolves `scripts/task_memory.py` from this skill, uses the current workspace root as the absolute `--workspace`, and only overrides that workspace when the brief explicitly says so.

```bash
python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
python scripts/task_memory.py archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
```

`init` creates `task-memory/task-<task-id>/task_state.md`, `reports/`, and `reports/archive/`; if needed it appends `-001`, `-002`, etc. and prints `task_id=<actual-task-id>`. `status` has no side effects and prints task/report paths plus pending/archived reports; with compatibility enabled, it can fall back to existing legacy `task-<task-id>/` only when no matching new-layout task exists. `create-report` creates a template and prints its absolute path; `--name` becomes lowercase hyphen-case. `archive-report` moves one absorbed report filename to `reports/archive/`, never edits `task_state.md`, and appends `-001`, `-002`, etc. instead of overwriting. Only the task-state owner may run `archive-report`; do not move reports with shell commands, wildcards, or directory operations.

## Brief Templates

Report-required subagent brief:

```text
Use $task-memory for this subtask. This is a report-required task-memory handoff. Follow the subagent protocol.

Task memory:
- task-id: <task-id>
- report name: <short report name>

Run `status` for this `task-id` using $task-memory.

Read the returned task_state path.

Create your report before writing findings:
Run `create-report` with the report name above using $task-memory.

Write to the generated report path.

Task:
<specific assignment>

Constraints:
- Do not modify task_state.md or source files unless explicitly assigned.
- Use the Report Shape from $task-memory; write absorption-ready prose.
- Fill `Scope` with the assigned boundaries.
- Put only durable conclusions, decisions, risks, final validation, failure signatures, side effects, and next actions into Absorbable Findings or Open or Not Checked.
- Omit routine validation/review/state-check detail, raw stdout, and repeated static-check detail unless durable.
- Start each evidence item with a hard pointer, then add at most one short fact.
- On success, return only the report path plus one high-level sentence, e.g. `Report written; conclusion: <one sentence>.`
- Do not use bullets or repeat report details in chat.
- If blocked, return only the reason, attempted command, and partial report path or `None`.
```

Worker implementation brief:

```text
Use $task-memory for this subtask. This is a report-required worker implementation handoff.

Task memory:
- task-id: <task-id>
- report name: <short report name>

Run `status` for this `task-id` using $task-memory.

Read the returned task_state path before implementation.

Create your report before writing findings:
Run `create-report` with the report name above using $task-memory.

Task:
<specific implementation assignment>

Write scope:
- Allowed: <files, directories, modules, or symbols the worker may modify>
- Forbidden: <files, directories, modules, or behaviors the worker must not modify>

Validation:
<scoped validation commands or checks to run, or `Not required; explain why not run`>

Constraints:
- Do not modify task_state.md.
- Modify source files only within the allowed write scope.
- Use existing project patterns and keep unrelated refactors out of scope.
- If implementation requires a new schema, generated file, public API, permission/cache/concurrency behavior, cross-package change, or expanded write scope, stop and report the risk instead of proceeding.
- Put final changes, durable decisions, validation results, failures, blockers, side effects, and open risks in the report.
- On success, return only the report path plus one high-level summary sentence to your direct parent.
- If blocked, return only the blocker, attempted command or checked pointer, and partial report path or `None`.
```

Command-only subagent brief:

```text
This is a command-only task-memory handoff. Use $task-memory for routing; load task context via status only when needed. Do not run create-report or write a report.

Task memory:
- task-id: <task-id>

If needed, run `status` for this `task-id` using $task-memory.

If you ran `status`, read the returned task_state path.

Do not run create-report. Do not write a report file. Do not modify task_state.md.

Task:
<specific command execution assignment>

Constraints:
- Run only the assigned command family and directly necessary observation commands.
- Do not modify source files unless explicitly assigned.
- Do not perform independent exploration, implementation, impact analysis, or decision support.
- Return command, cwd, pass/fail, exit code when available, scope, and the shortest useful output excerpt or error signature.
- Return results in chat only.
```
