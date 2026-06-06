---
name: task-memory
description: Maintain durable task_state.md memory, report artifacts, command-only handoff results, and absorbed report summaries. Use when starting exploration for a non-trivial task, when implementing a plan, or whenever the main chat thread needs continuing task-local state beyond chat history.
---

# Task Memory
Use this skill to keep long tasks, exploration work, and plan implementation recoverable without relying on chat history as source of truth.
Task memory lives under `--workspace`, normally the current workspace root, as `task-memory/task-<task-id>/task_state.md` plus `reports/archive/`.
`init` creates the `task-memory/` parent directory plus `task-<task-id>` or the next `-001`, `-002`, etc. variant under it, then prints `task_id=<actual-task-id>`. Use the actual task id thereafter.
Task memory root is `--workspace/task-memory/`; each task lives at `task-<task-id>/` with `task_state.md`, `reports/`, and `reports/archive/`.

## Activation Mode
On activation, follow the mode selected by the caller. Only `/root` or the root session may act as the Task-state owner; non-root agents must never infer or claim task-state ownership. A handoff agent must use the mode named in its brief; if the brief does not select `Report-required` or `Command-only`, do not infer ownership:
- Task-state owner: `/root` or the root session owns `task_state.md`, durable updates, report absorption/archive, final integration, and summaries.
- Report-required handoff agent: run `status`, read `task_state.md`, create exactly one report, write findings there, and return only the report path plus a brief status to the direct parent.
- Command-only handoff agent: run `status` and read `task_state.md` only when task context is needed, never run `create-report`, never write a report, and return command results in chat.
Handoff agents must not create, delegate to, manage, wait on, absorb, archive, or update `task_state.md`. If a handoff agent finds that more work is needed, record the recommended follow-up scope in the report or chat result for its parent.

## Core Protocol
The task-state owner (`/root` or the root session) owns `task_state.md` and updates it for durable goal/scope changes, decisions, completed owner work, important evidence, decision-bearing validation, blockers, open questions, and absorbed reports. Do not route the task-state owner's own work through `reports/` unless the user asks for a handoff or audit artifact.
Treat routine validation, review, and state-check results as non-durable by default. Record final/representative validation, failures, blockers, unresolved risks, next-step-changing not-run validation, unexpected side effects, and requested audit facts. Do not record intermediate passing validation, routine output, raw stdout, repeated command history, or local inspection details. When recording, keep one short conclusion plus the smallest useful pointer, command, affected-file summary, or error signature; merge repeats.

## Handoff Modes
Handoff agents never edit `task_state.md`. The task-state owner must explicitly brief each handoff as `Report-required` or `Command-only`; this skill only defines how those modes record task memory. Implementation, worker, code-modification, explorer, investigation, mapping, and impact-analysis handoffs are `Report-required`. Validation, test, build, smoke, command-run, and log-observation handoffs are `Command-only`.

Every task-memory handoff agent brief must start with `Use $task-memory` and include `task-id`. Report-required briefs must also include a parent-chosen `report name`. Do not repeat the skill path, script path, or workspace in normal briefs; handoff agents activate/read `$task-memory`, resolve bundled scripts, and use the current workspace unless the brief explicitly overrides it.
Report-required flow:
1. The task-state owner updates `task_state.md` when needed, then briefs the handoff agent with `Use $task-memory`, `task-id`, report name, status/create-report steps, and return format.
2. The handoff agent activates/reads this skill, runs `status`, reads `task_state.md`, creates exactly one report before findings, does the work, writes durable content into the absorption-oriented sections, writes only a short status or one-sentence result under `## Role Result`, and returns only the report path plus a brief status.
   Write durable findings, blockers, and scope changes into the report as they are discovered; do not wait until the end to write the first substantive report content.
   Before final response, reduce any substantive content originally intended for chat into `Conclusion`, `Absorbable Findings`, or `Open or Not Checked`. Keep `## Role Result` short; do not put evidence lists, risk lists, validation output, next steps, or long natural results there. For report-required handoffs, do not repeat report content, evidence lists, validation output, risks, blockers, or next steps in chat.
3. The task-state owner reads the report in full, absorbs durable content into `task_state.md`, and archives only when fully absorbed.
Do not add `Reports > Pending` when briefing or running `create-report`; `status` tracks live unarchived reports. Add Pending only after the task-state owner reads a finished report and durable content remains unabsorbed. When absorption completes, remove matching Pending, add one `Reports > Absorbed` note with filename, conclusion, and `State` location, then archive.
Command-only handoffs may run `status` only if task context is needed. They do not run `create-report`, do not write reports, and return results in chat. Command-only activation never implies report creation; unless the brief explicitly selects `Report-required`, do not run `create-report` or write a report. The task-state owner applies the validation/state-check rules before writing any command result to `task_state.md`; do not create synthetic absorbed-report notes.
Archived reports are best-effort audit copies, not durable state. Preserve resume-critical content in `task_state.md` before archiving; do not rely on archived reports.

## Absorption Rules
Keep `task_state.md` compact but sufficient to prevent repeated exploration after compaction. Preserve one durable evidence item per independent subsystem, decision, risk, or decision-bearing validation.
When absorbing a report, use `Conclusion`, `Absorbable Findings`, and `Open or Not Checked`. Preserve stable conclusions, decisions, risks, failure/validation status, exact evidence pointers (`path:line-line`, symbols, config keys, API fields, commands/tests, source URLs, error signatures), one short anti-reopen fact, and remaining uncertainty/blockers/next actions. Move active risks, blockers, uncertainties, and next actions into `Open`.
Before archiving, each durable item must be in `task_state.md`, intentionally discarded as non-durable, or left pending. If durable-looking evidence is discarded, briefly note why. Usually discard raw stdout, large diffs, routine review/state-check output, repeated command/search output, inspection output, reasoning traces, dead ends, abandoned hypotheses, and duplicate evidence after capturing the conclusion.
A report is absorbed only when the task-state owner or another agent can continue from `task_state.md` without reopening or regenerating it for the same decision.

## Report Shape
Ask handoff agents for absorption-ready summaries, not audit logs. Use `None`, `N/A`, or `Not checked` when a section does not apply. Prefer 1-5 high-signal bullets. Each absorbable finding should be copyable or easy to condense; evidence starts with a hard pointer plus at most one short fact. Exclude raw stdout, large diffs, routine/static-check detail, search/inspection output, reasoning, dead ends, duplicates, and unlikely-to-absorb information.
Use `## Role Result` only for a short role completion status or one-sentence result summary. Keep durable conclusions, evidence, risks, blockers, validation status, and next actions in `Conclusion`, `Absorbable Findings`, or `Open or Not Checked`; `Role Result` is not the main fact carrier. For report-required handoffs, do not repeat `Role Result` or other report content in chat.
````markdown
# <Report Title>
Created: <timestamp>; Task state read: <absolute task_state.md path>; Scope: <assigned handoff task and explicit boundaries>; Repo/context snapshot: <commit, branch, timestamp, or "not checked">
## Conclusion
- <1-2 bullets with the direct answer, decision, or failure status.>
## Absorbable Findings
- <Finding, decision, risk, failure status, or decision-bearing validation result.> Evidence: `<path:line-line>` `<symbol/config/API/test/command>` - <one short fact>.
- <Another finding, or `None` if no durable finding should be absorbed.> Evidence: `<command/test/error signature>` - <one short fact or `not checked`>.
## Open or Not Checked
- <0-3 bullets with blockers, unresolved questions, not-run validation, or next actions that change what the direct parent or task-state owner should do. Use `None` if closed.>
## Role Result
<Brief role completion status or one-sentence result summary, or `N/A` when there is no separate role result.>
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
`Goal` stores objective and success criteria. `State` stores phase, durable understanding, completed work, decisions, acceptance validation, and high-signal evidence. `Open` stores unresolved questions, blockers, and handoff-ready gaps. `Reports` stores Pending and Absorbed notes; Pending notes include filename/reason, Absorbed notes include filename, conclusion, and `State` location.
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
Before rewriting, run `status`, read `task_state.md`, and check pending reports. Absorb overlapping pending reports or explicitly leave them pending. Ask for options before modifying unless already provided; prefer `request_user_input` when available. If no question tool is available or the caller already provided enough direction, use the recommended defaults:
- Summary level: `Balanced` (recommended: compact low-value detail; keep active decisions/evidence/validation/open work), `Conservative`, or `Aggressive`.
- Evidence retention: `Hard pointers` (recommended: one pointer per active decision/risk/decision-bearing validation/subsystem finding), `Decision focused`, or `Minimal`.
- History handling: `Collapse absorbed notes` (recommended), `Keep timeline`, or `Current state only`.
When applying a summary, preserve `# Task State`, `Goal`, `State`, `Open`, and `Reports`. The result must support resume without chat history, archived reports, or reopening absorbed reports. Do not discard blockers, pending notes, active next actions, validation failures, final acceptance status, unexpected side effects, or evidence for open decisions. Remove routine validation/review/state-check history unless audit was requested.

## Resume Protocol
After compaction, handoff, or long pause, the task-state owner treats `task_state.md` as source of truth:
Resume steps: 1. Run `status` for workspace and task-id. 2. Read `task_state.md`. 3. Check pending reports from `status` and `Reports`. 4. Absorb or explicitly leave pending any report overlapping the next work. 5. Continue from `Goal`, `State`, `Open`, and pending report notes, not chat history alone.
Archived reports are audit history only; do not read or depend on them during normal resume.

## Scripts
Use bundled scripts for mechanical steps. Resolve `scripts/task_memory.py` from the directory containing this `SKILL.md`, not from the parent `skills/` directory; or call `task_memory.py` by its absolute path. Always pass an absolute `--workspace`; the script stores task memory under `--workspace/task-memory/`.
Do not expose script paths or workspace arguments in normal handoff agent briefs. After a handoff agent activates `$task-memory`, it resolves `scripts/task_memory.py` from this skill, uses the current workspace root as the absolute `--workspace`, and only overrides that workspace when the brief explicitly says so.
Run `python scripts/task_memory.py -h` for command syntax and examples.
`init` creates task memory, `status` inspects paths and reports without side effects, `create-report` creates one pending report template, and `archive-report` moves one absorbed report into `reports/archive/` without editing `task_state.md`. Only the task-state owner may run `archive-report`; do not move reports with shell commands, wildcards, or directory operations.

## Brief Templates
Use short natural-language briefs. Include only the task memory identifiers, the actual task, and boundaries that are specific to this handoff. Select `Report-required` for implementation/explorer handoffs and `Command-only` for validation handoffs. Do not paste the protocol rules unless they override the defaults above.

Report-required handoff agent brief:
```text
Use $task-memory for a report-required handoff agent. Task memory: task-id=<task-id>; report name=<short report name>.
Run `status`, read task_state, then run `create-report` before writing findings. <One or two sentences describing the assignment and its specific boundaries.>
Return only the report path and status; do not repeat report content in chat. If blocked, write the blocker into the partial report first, then return the blocker status and partial report path.
```

Command-only handoff agent brief:
```text
Use $task-memory for a command-only handoff. Task memory: task-id=<task-id>.
Run only <command family / exact command scope>. Use `status` only if task context is needed. Do not run `create-report` or write a report.
Return the command result in chat with pass/fail, exit code when available, and the shortest useful output excerpt or error signature.
```
