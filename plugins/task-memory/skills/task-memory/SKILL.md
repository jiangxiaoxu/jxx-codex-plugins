---
name: task-memory
description: Maintain durable task state for process-oriented work that may move through problem framing, exploration, analysis, implementation, and validation. Use as soon as progress, decisions, evidence, handoffs, or resume context should survive beyond chat history.
---

# Task Memory
Task memory keeps long work resumable without chat history. It lives under `--workspace/task-memory/task-<task-id>/` with `task_state.md`, `reports/`, and `reports/archive/`. `init` creates the task folder, using `-001`, `-002`, etc. when needed, and prints `task_id=<actual-task-id>`; use that id afterward.

## Modes And Ownership
On activation, follow the caller-selected mode. If a handoff brief does not select `Report-required` or `Command-only`, do not infer ownership.
- Task-state owner: only `/root` or the root session. Owns `task_state.md`, durable updates, report absorption/archive, final integration, and summaries.
- Report-required handoff: run `status`, read `task_state.md`, create exactly one report, maintain `Status` and `Last updated`, write compact findings as discovered, and return only report path plus brief status.
- Command-only handoff: run `status`/read `task_state.md` only when task context is needed; never run `create-report`; return command results in chat.

Only the task-state owner may run `init`, edit `task_state.md`, absorb, or archive. Handoff agents never edit `task_state.md`. If they find more work, put recommended follow-up scope in the report or chat result. For long self-contained implementation/code-modification work, the owner dispatches a worker handoff without forking chat context; small fixes, glue, conflict resolution, absorption/archive, and final response stay with the owner.

## Task State Rules
The owner records durable goal/scope changes, decisions, completed owner work, important evidence, blockers, open questions, and pending report state. Do not route owner work through `reports/` unless the user asks for handoff/audit output.

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

## Handoffs
The owner must explicitly brief each handoff as `Report-required` or `Command-only`. Use `Report-required` for implementation, worker, code modification, explorer, investigation, mapping, and impact analysis. Use `Command-only` for validation, test, build, smoke, command-run, and log observation.

All task-memory handoff briefs start with `Use $task-memory` and include `task-id`; report-required briefs also include a parent-chosen `report name`. Do not include skill path, script path, or workspace unless overriding the current workspace.

For worker implementation handoffs, use boundaries as goal guidance rather than exhaustive file limits. Workers may change directly related code, tests, config, public contracts, and docs needed for a coherent implementation; validation status stays in chat unless it reveals an independently actionable issue.

### Report-required Flow
1. Owner updates `task_state.md` if needed, then briefs the handoff with task id, report name, status/create-report steps, boundaries, and return format.
2. Handoff runs `status`, reads `task_state.md`, creates one report before substantive work, sets `Status: in-progress`, and keeps the report current while working.
3. Handoff writes durable findings, blockers, scope changes, and meaningful completed-work checkpoints as discovered; update `Last updated` for each meaningful update. Keep content absorption-oriented and compact; no logs or routine command output.
4. Before returning, reduce chat-intended substance into `Conclusion`, `Absorbable Findings`, or `Open or Unresolved`; set `Status: completed`, `blocked`, or `stopped`; keep `## Role Result` short. Chat return is only report path plus brief status.
5. For completed/blocked absorption, owner reads the report in full, absorbs durable content into `task_state.md`, and archives only when fully absorbed. `Status: in-progress` lifecycle cleanup is a separate archive path and never implies absorption.

Live `Status: in-progress` reports are parent-readable activity artifacts. On wait timeout/running status, the owner or direct parent may read the report and decide whether to wait, send bounded follow-up, interrupt/stop, take over, or request/route lifecycle cleanup by the owner after the handoff is no longer running. While the child can still write to the report, do not absorb/archive it or treat partial findings as final. A non-owner direct parent may use the report only for lifecycle decisions.

If a partial report is malformed, heading-incomplete, or half-written, treat it as `Status: in-progress`; do not absorb it. Only review/absorb an in-progress report, or archive it as lifecycle cleanup, after the handoff ended, returned completed/blocked, was stopped/closed, was taken over by the owner, or reached an external cancelled/terminal state. External lifecycle states do not add report `Status` values; treat them as stopped partial reports. Absorb only stable findings with clear evidence, move still-relevant risks/actions to `Open`, discard unstable partial content, then archive if appropriate.

Do not add `Reports > Pending` when briefing or creating reports; `status` tracks live/unarchived files separately from `task_state.md` pending notes. Add Pending only after the owner reads a finished or stopped-partial-reviewed report and durable content remains unabsorbed. Remove the Pending note when absorbed and archived; do not add absorbed-report history notes to `task_state.md`.

### Command-only Flow
Command-only handoffs may run `status` only if task context is needed. They never create/write reports. The owner must not copy command results into `task_state.md`; only record independently actionable underlying issues with stable pointers. Do not create synthetic absorbed-report notes.

## Absorption And Report Shape
Absorb from `Conclusion`, `Absorbable Findings`, and `Open or Unresolved`. Preserve stable conclusions, decisions, risks, exact evidence pointers (`path:line-line`, symbols, config keys, API fields, source URLs, error signatures), one anti-reopen fact, and remaining blockers/actions. Before archiving, each durable item must be in `task_state.md`, intentionally discarded as non-durable, or left pending. Discard raw stdout, diffs, routine checks, repeated searches, reasoning traces, dead ends, and duplicates after capturing the conclusion. A report is absorbed only when `task_state.md` is enough to continue without reopening/regenerating it.

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
Summary is an owner rewrite of `task_state.md`, not a report workflow. Before rewriting, run `status`, read `task_state.md`, and check live/unarchived reports plus `Reports` pending notes. Ask for summary options before modifying unless already provided; prefer `request_user_input` when available. Read report `Status` before absorption: absorb completed/blocked reports, or externally stopped/cancelled/terminal reports after stopped-partial review. Still-running `in-progress` reports are only lifecycle signals; leave them live unless the handoff is no longer running and the owner deliberately archives them as cleanup.

If options are not provided, default to `Balanced` summary, `Hard pointers` evidence, and `Current state only` history. Preserve `Goal`, `State`, `Open`, and `Reports`; keep active blockers, pending notes, next actions, unexpected side effects, and evidence for open decisions. Remove resolved blockers/risks/actions, stale pending notes, absorbed history, and validation/review/state-check history unless an active underlying issue remains.

Resume after compaction/handoff/pause: run `status`; read `task_state.md`; check live/unarchived reports and pending notes including report `Status`; absorb eligible reports or review stopped partials; use still-running `in-progress` reports only to wait/follow up/stop/take over; archive in-progress only after the handoff is no longer running. Continue from `Goal`, `State`, `Open`, live report state, and pending notes. Archived reports are best-effort audit copies, not durable state; preserve resume-critical content in `task_state.md` before archiving and do not rely on archived reports during normal resume.

## Scripts
Resolve `scripts/task_memory.py` from this `SKILL.md` directory. Always pass absolute `--workspace`; normal handoff briefs should not expose script paths or workspace args.

`python scripts/task_memory.py {init,status,create-report,archive-report} ...`
- `init --workspace <absolute-workspace> --task-id <task-id>` creates the task memory folder.
- `status --workspace <absolute-workspace> --task-id <task-id>` prints task paths and live/unarchived report files without side effects; missing `reports/` or `archive/` are treated as empty. Legacy `pending_reports`/`pending_report` output aliases refer to the same live/unarchived files, not `task_state.md` `Reports` pending notes.
- `create-report --workspace <absolute-workspace> --task-id <task-id> --name <report-name>` creates one live/unarchived report template with `Status: in-progress` and `Last updated`.
- `archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>` moves one report from `reports/` to `reports/archive/` without editing `task_state.md`, creating missing report directories when needed. Use only for absorbed reports or `Status: in-progress` cleanup after the handoff is no longer running. Only the owner may run it; do not move reports manually.

## Brief Templates
Report-required handoff:
```text
Use $task-memory for a report-required handoff agent. Task memory: task-id=<task-id>; report name=<short report name>.
Run `status`, read task_state, then run `create-report` before substantive work. Set `Status: in-progress`, keep `Last updated` current, and maintain compact findings, blockers, scope changes, and meaningful completed-work checkpoints while working. Keep required report headings intact on every save. <Assignment and boundaries.>
Before returning, set `Status: completed`, `blocked`, or `stopped` as appropriate. Return only the report path and status; do not repeat report content in chat. If blocked, write the blocker into the partial report first.
```

Worker implementation handoff:
```text
Use $task-memory for a report-required worker implementation handoff. Task memory: task-id=<task-id>; report name=<short report name>.
Run `status`, read task_state, then run `create-report` before substantive work. Set `Status: in-progress`, keep `Last updated` current, and maintain compact findings, blockers, scope changes, and meaningful completed-work checkpoints while working. Implement <goal> within <boundaries>; include directly related code/tests/config/public contracts/docs, and validate with <checks>.
Before returning, set `Status: completed`, `blocked`, or `stopped` as appropriate. Return only the report path and status. If blocked by non-validation issue or material scope change, write it and completed work into the report; validation status stays in chat unless it reveals an independently actionable issue.
```

Command-only handoff:
```text
Use $task-memory for a command-only handoff. Task memory: task-id=<task-id>.
Run only <command family / exact command scope>. Use `status` only if task context is needed. Do not run `create-report` or write a report.
Return pass/fail, exit code when available, and the shortest useful output excerpt or error signature.
```
