---
name: task-memory
description: Maintain durable task_state.md memory for task-state owners, report handoffs, command-only handoffs, and root-dispatched worker handoffs. Use when Codex needs to create, resume, update, or summarize task state; dispatch scoped work with task-id context; or absorb task-memory subagent reports.
---

# Task Memory
Use this skill to keep long tasks recoverable without relying on chat history as source of truth.
Task memory lives under `--workspace`, normally the current workspace root, as `task-memory/task-<task-id>/task_state.md` plus `reports/archive/`.
`init` creates the `task-memory/` parent directory plus `task-<task-id>` or the next `-001`, `-002`, etc. variant under it, then prints `task_id=<actual-task-id>`. Use the actual task id thereafter.
Task memory root is `--workspace/task-memory/`; each task lives at `task-<task-id>/` with `task_state.md`, `reports/`, and `reports/archive/`.

## Role Routing
On activation, route by role and handoff mode:
- Task-state owner: `/root` or the main task-state owner thread; owns `task_state.md`, durable updates, handoff dispatch, report absorption/archive, final integration, and cross-worker conflicts.
- Dispatching agent: only `/root` or the task-state owner may dispatch task-memory child work. Prefer worker handoffs for implementation when the ownership / responsibility boundary and validation expectation are clear; before dispatch, update `task_state.md` and include task-local context, boundary, constraints, validation, and expected return details in the child brief.
- Report-required subagent: run `status`, read `task_state.md`, create exactly one report, write findings there, and return only the report path plus one high-level summary sentence to the direct parent.
- Command-only subagent: run `status` and read `task_state.md` only when task context is needed, never run `create-report`, never write a report, and return command results in chat.
Subagents must not create, delegate to, manage, or wait on other subagents. If a subagent finds that more exploration, implementation, or command execution should be split out, it records the recommended follow-up scope in its report for `/root` or the task-state owner to assign.

## Core Protocol
The task-state owner owns `task_state.md` and updates it for durable goal/scope changes, decisions, completed owner work, important evidence, decision-bearing validation, blockers, open questions, and absorbed reports. Do not route the task-state owner's own work through `reports/` unless the user asks for a handoff or audit artifact.
Treat routine validation, review, and state-check results as non-durable by default. Record final/representative validation, failures, blockers, unresolved risks, next-step-changing not-run validation, unexpected side effects, and requested audit facts. Do not record intermediate passing validation, routine output, raw stdout, repeated command history, or local inspection details. When recording, keep one short conclusion plus the smallest useful pointer, command, affected-file summary, or error signature; merge repeats.

## Handoffs
Non-owner subagents never edit `task_state.md`.
Dispatch contract:
- `/root` or the task-state owner must choose `Report-required` or `Command-only` and include the matching canonical brief; do not rely on partial paraphrases.
- Every handoff brief must include `Use $task-memory`, `task-id`, mode-specific constraints, and a report name for `Report-required`.
- Do not repeat the skill path, script path, or workspace in normal handoffs; subagents activate/read `$task-memory`, resolve bundled scripts, and use the current workspace unless the brief explicitly overrides it.
- If mode is omitted, classify exploration, implementation, impact analysis, call tracing, decision support, durable evidence collection, or compaction-surviving results as `Report-required`; classify parent-specified command execution with no independent analysis as `Command-only`.
For implementation, prefer a worker handoff when the ownership / responsibility boundary and validation expectation can be stated clearly. Keep the work in the current `/root` or task-state owner thread only for very small edits, state/report absorption, final integration, or tasks that require immediate parent decisions while editing.
Report-required flow:
1. `/root` or the task-state owner updates `task_state.md`, then briefs the subagent with `Use $task-memory`, `task-id`, report name, status/create-report steps, return format, and `Do not modify task_state.md`.
2. Subagent activates/reads this skill, runs `status`, reads `task_state.md`, creates exactly one report before findings, does the work, writes fixed role output under `## Role Result` when required, and returns only the report path plus one high-level summary sentence.
3. `/root` or the task-state owner reads the report in full, absorbs durable content into `task_state.md`, and archives only when fully absorbed.
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
When a role has a required compact final structure, add `## Role Result` after `Open or Not Checked` and write the full fixed structure there. Keep `Conclusion`, `Absorbable Findings`, and `Open or Not Checked` concise and absorption-oriented; do not repeat the full role result in chat.
````markdown
# <Report Title>
Created: <timestamp>; Task state read: <absolute task_state.md path>; Scope: <assigned subtask and explicit boundaries>; Repo/context snapshot: <commit, branch, timestamp, or "not checked">
## Conclusion
- <1-2 bullets with the direct answer, decision, or failure status.>
## Absorbable Findings
- <Finding, decision, risk, failure status, or decision-bearing validation result.> Evidence: `<path:line-line>` `<symbol/config/API/test/command>` - <one short fact>.
- <Another finding, or `None` if no durable finding should be absorbed.> Evidence: `<command/test/error signature>` - <one short fact or `not checked`>.
## Open or Not Checked
- <0-3 bullets with blockers, unresolved questions, not-run validation, or next actions that change what the direct parent or task-state owner should do. Use `None` if closed.>
## Role Result
<Optional: exact fixed role result structure, or `N/A` when the role has no fixed structure.>
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
Resume steps: 1. Run `status` for workspace and task-id. 2. Read `task_state.md`. 3. Check pending reports from `status` and `Reports`. 4. Absorb or explicitly leave pending any report overlapping the next work. 5. Continue from `Goal`, `State`, `Open`, and pending report notes, not chat history alone.
Archived reports are audit history only; do not read or depend on them during normal resume.

## Scripts
Use bundled scripts for mechanical steps. Resolve `scripts/task_memory.py` relative to the absolute path of this `SKILL.md`, or call `task_memory.py` by its absolute path. Use `init` to allocate a task memory directory; use `status` with the actual task-id to inspect an allocated task. Always pass an absolute `--workspace`; the script stores task memory under `--workspace/task-memory/`.
Do not expose script paths or workspace arguments in normal subagent briefs. After a subagent activates `$task-memory`, it resolves `scripts/task_memory.py` from this skill, uses the current workspace root as the absolute `--workspace`, and only overrides that workspace when the brief explicitly says so.
```bash
python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
python scripts/task_memory.py archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
```
`init` creates `task-memory/task-<task-id>/task_state.md`, `reports/`, and `reports/archive/`; if needed it appends `-001`, `-002`, etc. and prints `task_id=<actual-task-id>`. `status` has no side effects and prints task/report paths plus pending/archived reports from `task-memory/task-<task-id>/`. `create-report` creates a template and prints its absolute path; `--name` becomes lowercase hyphen-case. `archive-report` moves one absorbed report filename to `reports/archive/`, never edits `task_state.md`, and appends `-001`, `-002`, etc. instead of overwriting. Only the task-state owner may run `archive-report`; do not move reports with shell commands, wildcards, or directory operations.

## Brief Templates
Report-required subagent brief:
```text
Use $task-memory for this report-required subtask. Follow the subagent protocol.
Task memory: task-id=<task-id>; report name=<short report name>
Run `status`, read the returned task_state path, then run `create-report` with the report name before writing findings.
Task: <specific assignment>
Constraints:
- Do not modify task_state.md or source files unless explicitly assigned.
- Do not create, delegate to, manage, wait on, or coordinate other subagents.
- Use the Report Shape from $task-memory; write absorption-ready prose and put any fixed final structure under `## Role Result`.
- Fill `Scope` with the assigned boundaries.
- Put only durable conclusions, decisions, risks, final validation, failure signatures, side effects, and next actions into Absorbable Findings or Open or Not Checked.
- Omit routine detail, raw stdout, repeated checks, and chat-expanded report details.
- Start each evidence item with a hard pointer plus at most one short fact.
- On success, return only the report path plus one high-level sentence, e.g. `Report written; conclusion: <one sentence>.`
- If blocked, return only the reason, attempted command, and partial report path or `None`.
```

Worker implementation brief:
```text
Use $task-memory for this subtask. This is a report-required worker implementation handoff.
Task memory: task-id=<task-id>; report name=<short report name>
Run `status`, read the returned task_state path before implementation, then run `create-report` with the report name before writing findings.
Task: <specific implementation assignment>
Ownership / responsibility boundary: <files, directories, modules, symbols, behaviors, or responsibility area the worker owns for this assignment; include any explicit exclusions only when needed>
Validation: <scoped validation commands or checks to run. Worker should complete practical validation when feasible. If validation is long-running or requires another subagent, write a `Verification handoff` in the report for `/root` or the task-state owner to assign. Use `Not required` only with a brief reason.>
Constraints:
- Do not modify task_state.md.
- Do not create, delegate to, manage, wait on, or coordinate other subagents.
- Work within the ownership / responsibility boundary, discovering directly related files when needed.
- Use existing project patterns and keep unrelated refactors out of scope.
- If work expands into important review boundaries such as schemas, generated files, public APIs, lockfiles, dependency manifests, global config, or cross-package contracts, record changed paths, rationale, validation, and risks.
- Put final changes, durable decisions, validation results, failures, blockers, side effects, open risks, and the worker compact result under `## Role Result` in the report.
- Use `Verification handoff` only for blocked validation: missing tools, unavailable environment, parent-forbidden execution, or a required parent decision.
- On success, return only the report path plus one high-level summary sentence to your direct parent.
- If blocked, return only the blocker, attempted command or checked pointer, and partial report path or `None`.
```

Command-only subagent brief:
```text
This is a command-only task-memory handoff. Use $task-memory for routing; load task context via status only when needed. Do not run create-report or write a report.
Task memory: task-id=<task-id>
If needed, run `status` for this `task-id` and read the returned task_state path.
Task: <specific command execution assignment>
Constraints:
- Run only the assigned command family and directly necessary observation commands.
- Do not run create-report, write a report file, modify task_state.md, or create/delegate/manage/wait subagents.
- Do not modify source files unless explicitly assigned.
- Do not perform independent exploration, implementation, impact analysis, or decision support.
- Return command, cwd, pass/fail, exit code when available, scope, and the shortest useful output excerpt or error signature.
- Return results in chat only.
```
