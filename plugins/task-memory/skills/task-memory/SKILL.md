---
name: task-memory
description: Maintain durable task state and handoff reports for wide-scope search, exploration, and investigation tasks, and for long-running or multi-step coding work. Use when a task needs durable decision tracking, handoffs, interruption handling, or resume context. Also use before spawning subagents for exploration, investigation, implementation, or code-modification work where findings, decisions, or changes should persist. Do not activate solely for validation, build, test, smoke, benchmark, log-observation, brief local edits, or one-shot commands.
---

# Task Memory
Task memory keeps long work resumable without chat history. It lives under `--workspace/task-memory/<task-id>/` with `task_state.md`, `reports/`, `reports/archive/`, and `artifacts/`. `task-id` must start with `task-`, such as `task-thumbnail-cache`; the helper uses that id as the folder name and does not add another prefix. `init` creates the task folder, using `-001`, `-002`, etc. when needed, and prints `task_id=<actual-task-id>`; use that id afterward.

## AI Execution Checklist
Script commands in this skill are run through the bundled helper at `<skill_dir>/scripts/task_memory.py`, where `<skill_dir>` is the directory that contains this `SKILL.md`. Do not resolve `scripts/task_memory.py` from the current working directory, plugin root, plugin cache root, repository root, or any hard-coded installed cache version. Before the first helper command in a session, verify that `<skill_dir>/scripts/task_memory.py` exists; if it does not, search only the current skill bundle for `scripts/task_memory.py`, use the discovered absolute path, and report the path mismatch briefly. Always pass absolute `--workspace`.

First choose the current role:
- Task owner: `init` only if needed, then `status`, read `task_state.md`, check live reports, update durable state, dispatch handoffs, absorb finished reports, and archive only after absorption.
- Report-required handoff: `status`, read `task_state.md`, run `create-report` once before substantive work, keep the report current, set final `Status`, then return only report path plus brief status.
- Command-only handoff: run only the assigned command scope; use `status` only if task context is needed; never create/write reports; return the shortest useful result.

Critical guardrails:
- Never let handoff agents edit `task_state.md`.
- Never let command-only handoffs run `create-report` or write reports.
- Do not record chronological work logs, step-by-step progress, attempt histories, or routine action ledgers in `task_state.md` or reports; rewrite them into current conclusions, active decisions, open blockers, compact findings, or delete them.
- When durable resumability is needed and no task-id exists, the task owner runs `init` before dispatching handoffs.
- Before implementing a previously stated plan, the task owner must record the current implementation plan in `task_state.md` before dispatching implementation-class handoffs or starting implementation work.
- When this skill is active and a task-id exists, delegated exploration, investigation, mapping, impact analysis, implementation, code modification, and validation briefs must start with `Use $task-memory` and use the appropriate handoff template.
- When subagent tooling is available and delegation is permitted, the task owner dispatches exploration-class and implementation-class work to the matching subagent role by default rather than executing it directly.
- Under those conditions, prefer an explorer subagent for exploration-class work. Implementation-class work that can be stated as a complete work item, including feature or behavior changes and sustained/high-volume MCP tool calls that modify external systems as the main work, must use a worker subagent even when the change is not isolated or independent. Exceptions are limited to very small glue, local conflict resolution, report absorption/archive, final response, unresolved task-owner decisions, or lifecycle/conflict constraints. The task owner keeps lifecycle/state ownership; the subagent owns its assigned evidence chain or implementation scope until it returns.
- Prefer splitting implementation-class work into parallel worker slices when each slice can be completed independently. Parallel implementation workers require disjoint write sets, no shared public contract owner, explicit exclusive and forbidden scopes, validation boundaries, and parent-owned final integration.
- Never archive a live `Status: in-progress` report while the child may still write to it.
- Never record routine validation, review, build, test, state-check output, raw stdout, or command history in `task_state.md`.
- Never expose the script path or workspace args in normal handoff briefs unless overriding the current workspace.
- After successful `init`, put agent-created task temporary assets under the task `artifacts/` directory by default. This applies to temporary files the agent creates for the current task, such as generated images, manual downloads, extracted archives, temporary clones, scratch scripts, screenshots, and intermediate bundles. Do not move or redirect normal tool/build/test outputs solely because task memory exists.

## Modes And Ownership
On activation, follow the caller-selected mode. If a handoff brief does not select `Report-required` or `Command-only`, do not infer ownership.
- Task owner: only `/root` or the root session. Owns the task lifecycle: `task_state.md`, durable updates, handoff dispatch, report absorption/archive, final integration, and summaries.
- Report-required handoff: run `status`, read `task_state.md`, create exactly one report, maintain `Status` and `Last updated`, write compact findings as discovered, and return only report path plus brief status.
- Command-only handoff: run `status`/read `task_state.md` only when task context is needed; never run `create-report`; return command results in chat.

Only the task owner may run `init`, edit `task_state.md`, absorb, or archive. Handoff agents never edit `task_state.md`. If they find more work, put recommended follow-up scope in the report or chat result. Handoff agents own only their assigned scope; final integration and final response stay with the task owner.

## Scripts
Resolve the helper script as `<skill_dir>/scripts/task_memory.py`, with `<skill_dir>` equal to the directory containing this `SKILL.md`. The script is not at the plugin version root. Use an absolute script path after resolution, especially from installed cache locations. Always pass absolute `--workspace`; normal handoff briefs should not expose script paths or workspace args.

`python <skill_dir>/scripts/task_memory.py {init,status,create-report,archive-report} ...`
- `--task-id` is normalized to lowercase hyphen-case, must start with `task-`, and is used directly as `task-memory/<task-id>/`; the helper does not add a `task-` prefix.
- `init --workspace <absolute-workspace> --task-id <task-id>` creates the task memory folder.
- `status --workspace <absolute-workspace> --task-id <task-id>` prints task paths and live/unarchived report filenames without side effects; missing `reports/` or `archive/` are treated as empty.
- `create-report --workspace <absolute-workspace> --task-id <task-id> --name <report-name>` creates one live/unarchived report template with `Status: in-progress` and `Last updated`.
- `archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>` moves one report from `reports/` to `reports/archive/` without editing `task_state.md`, creating missing report directories when needed. Use only for absorbed reports or `Status: in-progress` cleanup after the handoff is no longer running. Only the task owner may run it; do not move reports manually.

## Task State Rules
The task owner records durable goal/scope changes, decisions, completed task-owner work, important evidence, blockers, open questions, and pending report state. Do not route task-owner work through `reports/` unless the user asks for handoff/audit output.

Keep `task_state.md` current, not historical. Remove resolved issues, risks, blockers, pending reports, questions, and next actions; keep only active decisions, behavior facts, anti-reopen evidence, and resume-critical follow-up. Do not stage task-memory files unless the user explicitly asks or already staged them.

Validation, review, build, test, and state-check results are non-durable. Do not record pass/fail, not-run status, raw stdout, command history, or routine inspection. If a check reveals an independently actionable underlying issue, record that issue under `State` or `Open` with one short conclusion plus a stable pointer/error signature, without validation framing.

```markdown
# Task State
## Goal
## State
## Open
## Reports
```
`Goal` stores objective/success criteria. `State` stores phase, durable understanding, completed work, decisions, and high-signal evidence. `Open` stores active questions, blockers, risks, and handoff-ready gaps. `Reports` stores only pending/unabsorbed report notes; no absorbed/archive history and no `Validation` section.

## Artifact Storage
After task memory is initialized, store agent-created task temporary assets in `--workspace/task-memory/<task-id>/artifacts/` unless the user or tool requires another location. Use this directory for files the agent intentionally creates for the current task, such as generated images, manual downloads, temporary cloned repositories, extracted archives, screenshots, scratch scripts, and intermediate bundles that may be useful for cleanup, handoff, resume, or audit.

Do not move, copy, or redirect normal outputs produced by existing repo tools just to centralize them. Build/test logs, compiler caches, package-manager caches, coverage output, framework-generated files, and other command side effects should stay where the tool normally writes them unless the user asks, the command explicitly supports a harmless output path, or the agent is creating a separate task-specific capture file.

Keep `task_state.md` and reports compact: reference artifacts by stable path only when they are resume-critical or evidence-bearing. Do not paste binary data, generated file contents, large logs, or routine command output into `task_state.md` or reports. If a temporary file must stay outside `artifacts/`, record why and where only when that location is resume-critical.

## Handoffs
The task owner must explicitly brief each handoff as `Report-required` or `Command-only`. Use `Report-required` for exploration, investigation, mapping, impact analysis, implementation, code modification, and any validation that needs durable findings. Use `Command-only` only for validation, test, build, smoke, command-run, benchmark, or log observation limited to exact command execution with no durable findings expected.

All task-memory handoff briefs start with `Use $task-memory` and include `task-id`; report-required briefs also include a parent-chosen `report name`. Do not include skill path, script path, or workspace unless overriding the current workspace.

For exploration-class work handoffs, use boundaries as investigation guidance rather than exhaustive search limits. When subagent tooling is available, delegation is permitted, and the assignment has a clear investigation question or scope, prefer a report-required handoff to an explorer subagent. The explorer subagent may read related code, config, docs, tests, and external sources when allowed and needed to answer the assigned evidence chain. The task owner does not independently advance that evidence chain while the explorer subagent owns it.

For implementation-class work handoffs, use boundaries as goal guidance rather than exhaustive file limits. When subagent tooling is available, delegation is permitted, and the assignment can be stated as a complete implementation task with a clear goal and no unresolved task-owner decision that must be answered before coding, it must use a report-required implementation handoff to a worker subagent. Prefer fan-out into parallel worker slices when the work can be decomposed into independently completable implementation slices; each slice should have one worker owner and a coherent end-to-end goal, not just a mechanical file edit.

When implementation follows a plan that was already produced in chat, a report, or an earlier task-owner decision, the task owner must update `task_state.md` so it contains the current implementation plan before any worker is spawned or any implementation work starts. Record only resumable plan substance: objective and success criteria, selected approach, durable decisions, write set or ownership slices, public contract owner, validation boundary, blockers or assumptions, and next actions. When recording a new implementation plan, replace or prune any completed, superseded, or no-longer-actionable implementation plan details; do not keep a chronological plan ledger in `task_state.md`. Do not copy verbose reasoning, rejected alternatives, routine validation notes, or command history. If the plan depends on unresolved questions, put them in `Open` and do not dispatch implementation workers that depend on those answers.

A single worker's slice does not need to be isolated or independent; the worker may make related cross-file, cross-module, contract, test, config, or doc changes needed for a coherent implementation. Parallel implementation workers are stricter: run them in parallel only when their write sets are disjoint and they do not share a public contract owner. If slices depend on a shared API, schema, config, route, migration, generated interface, or other public contract, the parent must resolve the contract before dispatch or assign that contract to exactly one worker and forbid other workers from editing it. For parallel workers, each brief must state exclusive write scope, forbidden scope, public contract owner or `None`, validation boundary, and integration note. The task owner does not implement the same change inline while any worker owns it and remains responsible for fan-in: absorbing reports, resolving conflicts, integrating cross-slice behavior, and running final cross-slice validation. Validation status stays in chat unless it reveals an independently actionable issue.

### Subagent Dispatch Gate
When this skill is active and a task-id exists, treat subagent dispatch as part of the task-memory workflow. Before delegating exploration, investigation, mapping, impact analysis, implementation, code modification, or validation, classify the handoff and choose the matching template:
- Report-required: exploration, investigation, mapping, impact analysis, implementation, code modification, and validation that needs durable findings.
- Command-only: build, test, smoke, benchmark, log observation, exact command execution, and validation limited to command/log observation with no durable findings expected.

The parent must use the selected task-memory handoff template before calling `spawn_agent`. The brief should already answer the gate checks:
1. Is there an active task-id for this work?
2. Does the delegated task need durable findings or command-only validation?
3. Does the initial prompt include the required task-memory handoff preamble?
4. For implementation-class work, has the current implementation plan been recorded in `task_state.md` and are unresolved plan blockers recorded in `Open`?

If the work has an active task-id and the delegated task is not purely conversational, the subagent brief must start with one of the skill templates. The parent must correct any missing preamble item before dispatch. If classification is uncertain, use Report-required unless the handoff is limited to exact command execution and has no durable findings to preserve.

Purely conversational means the child is only being asked to clarify scope, coordinate next steps, or answer a short process question without reading task/repo files, running commands, searching externally, changing files, or producing durable findings. A brief that asks for evidence, exploration, analysis, mapping, validation, implementation, or resume-relevant output is not purely conversational.

Meaningful work starts once the child reads task/repo/source/config/docs, runs a command, searches, edits files, creates a report, or produces task-specific analysis or findings. Startup, acknowledgement, or an immediate clarification question before those actions does not count as meaningful work.

### Required Handoff Preamble
For report-required handoffs, the spawned agent message must include all of these required elements. Markdown code formatting around commands is encouraged and still satisfies the gate:
- `Use $task-memory`
- `Task memory: task-id=task-<name>`
- `report name=<report-name>`
- Instruction to run `status`, read `task_state`, then run `create-report` before substantive work.
- Instruction to return only report path plus status.

For command-only handoffs, the spawned agent message must include all of these required elements:
- `Use $task-memory`
- `Task memory: task-id=task-<name>`
- Instruction not to run `create-report` or write a report.
- Exact command or command family
- Expected pass/fail output shape

### Anti-patterns
Do not write a bare delegation prompt such as:
```text
Investigate X and return findings.
```

When task-memory is active and a task-id exists, convert that prompt to a report-required handoff with the task-id and a parent-chosen report name.

### Missed Handoff Recovery
If the parent notices that a subagent was spawned without the required task-memory preamble:
- If the subagent has not started meaningful work, stop or close it and respawn with the correct handoff.
- If it already completed, do not treat its chat result as durable task memory until the parent records the durable findings in `task_state.md`.
- Note the recovery in `task_state.md` if the missed handoff affects resumability.

### Report-required Flow
1. Task owner updates `task_state.md` if needed, then briefs the handoff with task-id, report name, status/create-report steps, boundaries, and return format.
2. Handoff runs `status`, reads `task_state.md`, creates one report before substantive work, sets `Status: in-progress`, and keeps the report current while working.
3. Handoff writes durable findings, blockers, scope changes, and meaningful completed-work outcomes as discovered; update `Last updated` for each meaningful update. Keep content absorption-oriented and compact; no logs or routine command output.
4. Before returning, reduce chat-intended substance into `Conclusion`, `Absorbable Findings`, or `Open or Unresolved`; set `Status: completed`, `blocked`, or `stopped`; keep `## Role Result` short. Chat return is only report path plus brief status.
5. For completed/blocked absorption, task owner reads the report in full, absorbs durable content into `task_state.md`, and archives only when fully absorbed. `Status: in-progress` lifecycle cleanup is a separate archive path and never implies absorption.

Do not add `Reports > Pending` when briefing or creating reports; `status` tracks live/unarchived files separately from `task_state.md` pending notes. Add Pending only after the task owner reads a finished or stopped-partial-reviewed report and durable content remains unabsorbed. Remove the Pending note when absorbed and archived; do not add absorbed-report history notes to `task_state.md`.

### Command-only Flow
Command-only handoffs may run `status` only if task context is needed. They never create/write reports. The task owner must not copy command results into `task_state.md`; only record independently actionable underlying issues with stable pointers. Do not create synthetic absorbed-report notes.

## Report Lifecycle And Absorption
- Live `Status: in-progress` while the child may still write: lifecycle signal only. The task owner or direct parent may read it to decide wait/follow-up/stop/takeover/cleanup. Do not absorb, archive, or treat partial findings as final.
- Non-task-owner direct parent reading live `in-progress`: use the report only for lifecycle decisions.
- `Status: completed` or `Status: blocked`: task owner reads the report in full, absorbs durable content into `task_state.md`, then archives only when fully absorbed.
- `Status: stopped`, or externally stopped/cancelled/terminal: task owner reviews stable findings, moves still-relevant risks/actions to `Open`, discards unstable partial content, and archives if appropriate. External lifecycle states do not add report `Status` values.
- Malformed, heading-incomplete, or half-written partial report: treat as `Status: in-progress` until the handoff is terminal. Do not absorb it while the child can still write.

Absorb from `Conclusion`, `Absorbable Findings`, and `Open or Unresolved`. Preserve stable conclusions, decisions, risks, exact evidence pointers (`path:line-line`, symbols, config keys, API fields, source URLs, error signatures), one anti-reopen fact, and remaining blockers/actions. Before archiving, each durable item must be in `task_state.md`, intentionally discarded as non-durable, or left pending. Discard raw stdout, diffs, routine checks, repeated searches, reasoning traces, dead ends, duplicates, per-version chronology, and routine validation history after capturing the conclusion. A report is absorbed only when `task_state.md` is enough to continue without reopening/regenerating it.

Reports should be absorption-ready summaries, not audit logs. Use `None`, `N/A`, or `Not checked` when needed; prefer 1-5 high-signal bullets. `Status` is only `in-progress`, `completed`, `blocked`, or `stopped`; `Last updated` is the latest meaningful update time.

````markdown
# <Report Title>
Created: <timestamp>
Task state read: <absolute task_state.md path>
Scope: <assigned handoff task and explicit boundaries>
Repo/context snapshot: <commit, branch, timestamp, or "not checked">
Status: <in-progress|completed|blocked|stopped>
Last updated: <timestamp>
## Conclusion
- <1-2 bullets with answer, decision, or non-validation blocker.>
## Absorbable Findings
- <Finding, decision, risk, blocker, unexpected side effect, audit fact, or independently actionable issue.> Evidence: `<path:line-line>` `<symbol/config/API/error signature>` - <one short fact>.
- <Another finding, or `None`.> Evidence: `<path/error signature>` - <one short fact or `not checked`>.
## Open or Unresolved
- <0-3 blockers, questions, or next actions. Use `None` if closed.>
## Role Result
<Brief completion status or one-sentence result summary, or `N/A`.>
````

## Summary And Resume
Summary is a task-owner rewrite of `task_state.md`, not a report workflow. Before rewriting, run `status`, read `task_state.md`, and check live/unarchived reports plus `Reports` pending notes. Ask for summary options before modifying unless already provided; prefer `request_user_input` when available. Read report `Status` before absorption: absorb completed/blocked reports, or externally stopped/cancelled/terminal reports after stopped-partial review. Still-running `in-progress` reports are only lifecycle signals; leave them live unless the handoff is no longer running and the task owner deliberately archives them as cleanup.

If options are not provided, default to `Balanced` summary, `Hard pointers` evidence, and `Current state only` history. Preserve `Goal`, `State`, `Open`, and `Reports`; keep active blockers, pending notes, next actions, unexpected side effects, and evidence for open decisions. Remove resolved blockers/risks/actions, stale pending notes, absorbed history, and validation/review/state-check history unless an active underlying issue remains.

Compress verbose histories into a resumable decision/state summary. Keep final contract state, version boundaries, durable decisions, current behavior facts, known pitfalls that prevent reopening resolved paths, and future open items. Delete per-version ledger entries, chronological work logs, repeated attempts, routine validation history, and obsolete intermediate states unless they explain a still-active compatibility boundary, blocker, or decision.

Resume after compaction/handoff/pause: run `status`; read `task_state.md`; check live/unarchived reports and pending notes including report `Status`; absorb eligible reports or review stopped partials; use still-running `in-progress` reports only to wait/follow up/stop/take over; archive in-progress only after the handoff is no longer running. Continue from `Goal`, `State`, `Open`, live report state, and pending notes. Archived reports are best-effort audit copies, not durable state; preserve resume-critical content in `task_state.md` before archiving and do not rely on archived reports during normal resume.

## Brief Templates
Choose report-required for exploration, investigation, mapping, impact analysis, implementation, code modification, and any validation that needs durable findings. Choose command-only only for validation, test, build, smoke, command-run, benchmark, or log observation limited to exact command execution with no durable findings expected.

Report-required handoff:
```text
Use $task-memory for a report-required handoff to a subagent. Task memory: task-id=task-<name>; report name=<short report name>.
Run `status`, read `task_state`, then run `create-report` before substantive work. Set `Status: in-progress`, keep `Last updated` current, and maintain compact findings, blockers, scope changes, and meaningful completed-work outcomes while working. Keep required report headings intact on every save. <Assignment and boundaries.>
Before returning, set `Status: completed`, `blocked`, or `stopped` as appropriate. Return only report path plus status; do not repeat report content in chat. If blocked, write the blocker into the partial report first.
```

Explorer handoff:
```text
Use $task-memory for a report-required handoff to an explorer subagent. Task memory: task-id=task-<name>; report name=<short report name>.
Run `status`, read `task_state`, then run `create-report` before substantive work. Set `Status: in-progress`, keep `Last updated` current, and maintain compact findings, blockers, scope changes, and meaningful completed-work outcomes while working. Own the evidence chain for <investigation question> within <boundaries>; inspect related code/config/docs/tests and external sources when allowed and needed.
Before returning, set `Status: completed`, `blocked`, or `stopped` as appropriate. Return only report path plus status; do not repeat report content in chat. If blocked, write the blocker into the partial report first.
```

Implementation handoff:
```text
Use $task-memory for a report-required implementation handoff to a worker subagent. Task memory: task-id=task-<name>; report name=<short report name>.
Run `status`, read `task_state`, then run `create-report` before substantive work. Treat the implementation plan in `task_state.md` as the parent-owned source of truth; if the plan is missing, stale, or blocked by unresolved `Open` items that affect this slice, stop and report that blocker before editing. Set `Status: in-progress`, keep `Last updated` current, and maintain compact findings, blockers, scope changes, and meaningful completed-work outcomes while working. Own the implementation for <goal> within <boundaries>; include related code/tests/config/public contracts/docs, and validate with <checks>. For parallel implementation slicing, use one worker per slice and include: exclusive write scope=<files/modules>; forbidden scope=<files/modules/contracts>; public contract owner=<owner or None>; validation boundary=<checks owned by this worker>; integration note=<what the parent will combine later>.
Before returning, set `Status: completed`, `blocked`, or `stopped` as appropriate. Return only report path plus status. If blocked by non-validation issue or material scope change, write it and completed work into the report; validation status stays in chat unless it reveals an independently actionable issue.
```

Command-only handoff:
```text
Use $task-memory for a command-only handoff. Task memory: task-id=task-<name>.
Exact command or command family: <command family / exact command scope>. Expected pass/fail output shape: <pass/fail, exit code when available, and shortest useful output excerpt or error signature>.
Run only the assigned command scope. Use `status` only if task context is needed. Do not run `create-report` or write a report.
Return pass/fail, exit code when available, and the shortest useful output excerpt or error signature.
```
