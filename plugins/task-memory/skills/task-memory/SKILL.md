---
name: task-memory
description: Maintain durable task_state.md memory with summaries, report handoffs, and command-only handoffs.
---

# Task Memory

Use this skill to keep long tasks recoverable without treating chat history as the source of truth.

Task memory lives under the absolute workspace path passed to `--workspace`; use the current project/workspace root unless the user specifies another location. Identify each task with a workspace-unique `task-id`, such as `agent-memory` or `thumbnail-validation`.

```text
task-<task-id>/
  task_state.md
  reports/
    archive/
```

`init` creates `task-<task-id>` by default. If that directory already exists, it creates the next available numbered task id such as `task-<task-id>-001` and prints `task_id=<actual-task-id>`. Use that actual task id for later commands.

## Core Protocol

Root owns `task_state.md`.

Root updates `task_state.md` whenever durable memory changes: goal/scope, decisions, completed root work, important evidence, decision-bearing validation, blockers, open questions, and absorbed reports.

## Validation, Review, and State Checks

State checks inspect current task, worktree, environment, or generated-output state; `state check` is a category, while `status` is the task-memory script command. Treat routine validation, review, and state-check results as non-durable by default. Write them to `task_state.md` only when they change resume, decisions, validation, or handoff.

Record final/representative validation, failures, blockers, unresolved risks, next-step-changing not-run validation, unexpected side effects including tracked-file changes caused or revealed by validation/review/state-check commands, and requested audit facts. Do not record intermediate passing validation, routine review/state-check output, raw stdout, repeated command history, or local inspection details just because they were produced.

When recording one, keep one short conclusion plus the smallest useful pointer, command, test, affected-file summary, or error signature. Merge repeats into the current validation or risk entry instead of appending a timeline.

Do not route root's own work through `reports/` unless the user explicitly asks for a handoff or audit artifact.

Subagents never edit `task_state.md`. Choose the handoff mode by task shape, not by agent type:

- Use a report-required handoff for exploration, implementation, impact analysis, call tracing, decision support, durable evidence collection, or any subtask whose result should survive context compaction as independent evidence.
- Use a command-only handoff only when the subtask executes parent-specified commands and returns command results, exit status, scoped output, or short error signatures without independent exploration, implementation, or durable analysis.

For report-required handoffs, the subagent activates/reads this skill first, runs `status`, reads `task_state.md`, creates exactly one report, does the assigned work, writes findings to that report, and returns only the report path plus one high-level sentence summarizing the result to root.

For command-only handoffs, the subagent may run `status` if it needs task context, but it does not run `create-report` and does not write to `reports/`. It returns results in chat. Root applies the validation/review/state-check rules before writing any command result into `task_state.md`.

Reports are temporary inbox items. After full absorption into `task_state.md`, root archives the report under `reports/archive/` and keeps only a short absorbed-report note. Full absorption means resume does not require reopening or regenerating that report.

Archived reports are best-effort audit copies, not durable state. Preserve everything needed to continue in `task_state.md` before archiving.

Before dispatching a report-required subagent:

1. Update `task_state.md` with latest goal, state, open items, and existing pending reports, if any.
2. Activate this skill for the subagent with `Use $task-memory`; pass it as a structured skill item when supported.
3. Include absolute workspace path, `task-id`, report name, status/create-report steps, report-return format, and `Do not modify task_state.md`.

Do not add `Reports > Pending` when dispatching or running `create-report`. Add one only if root reads the finished report and durable content remains unabsorbed; until then, `status` tracks live unarchived reports.

After a report-required subagent finishes:

1. Read the report in full; do not rely only on returned key points.
2. Absorb durable content into `task_state.md`.
3. If anything remains unabsorbed, keep the report pending and note why under `Reports > Pending`.
4. When complete, remove the matching `Reports > Pending` note if one exists, add one `Reports > Absorbed` note with filename, conclusion, and `State` location, then archive. Do not archive merely because the headline was copied.

## Absorption Rules

Keep `task_state.md` compact, but preserve enough pointers and findings to prevent repeated exploration after compaction. Preserve one durable evidence item per independent subsystem, decision, risk, or decision-bearing validation; combine related pointers when possible.

When absorbing a report, use `Conclusion`, `Absorbable Findings`, and `Open or Not Checked`. Preserve:

- Stable conclusion, decision, risk, decision-bearing validation result, or failure status.
- Exact evidence pointers: `path:line-line`, symbols, config keys, API fields, command/test names, source URLs, or error signatures.
- One short fact after an evidence pointer when it prevents immediate source reopening.
- Remaining uncertainty, blocker, not-checked validation, and next action.

Move remaining risks, blockers, uncertainties, and next actions into `Open`.

Before archiving, each durable item must be represented in `task_state.md`, intentionally discarded as non-durable, or left pending. If durable-looking evidence is discarded, briefly note why. Usually discard raw stdout, large diffs, routine review/state-check output, repeated command/search output, inspection output, reasoning traces, dead ends, abandoned hypotheses, and duplicate evidence after the durable conclusion is captured.

A report is absorbed only when another agent can continue from `task_state.md` without reopening or regenerating it for the same decision.

For command-only handoffs, do not create a synthetic absorbed-report note. If the command result is durable under the validation/review/state-check rules, root records it directly under `State` or `Open` with the command, result, scope, and short error signature when relevant. Otherwise leave it in chat.

## Report Shape

Ask subagents for absorption-ready summaries, not audit logs. Use `None`, `N/A`, or `Not checked` when a section does not apply. Prefer 1-5 high-signal bullets.

Each absorbable finding should be copyable or easy to condense into `task_state.md`. Evidence must start with a hard pointer and at most one short fact. Do not paste raw stdout, large diffs, routine review/state-check output, intermediate successful validation output, search/inspection output, reasoning process, dead ends, duplicate evidence, or unlikely-to-absorb information.

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

- <0-3 bullets with blockers, unresolved questions, not-run validation, or next actions that change what root should do. Use `None` if closed.>
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

`Goal` stores objective and success criteria. `State` stores current phase, durable understanding, completed work, decisions, acceptance-relevant validation, and high-signal evidence. `Open` stores unresolved questions, blockers, and next subagent-ready gaps. `Reports` stores pending and absorbed report notes.

Under `Reports`, use `Pending` and `Absorbed` sublists. Pending notes include filename and why pending; Absorbed notes include filename, conclusion, and `State` location. When a pending report becomes absorbed, remove its matching Pending note.

Within `State`, prefer this compact shape for evidence-bearing findings. Include at least one durable finding, evidence ledger item, or validation item unless the report only confirms no durable change:

```markdown
- Current phase: <phase>
- Durable findings:
  - <finding or decision> - evidence: `<path:line-line>` `<symbol/test/command>`; validation: <full/scoped/probe/not checked>.
- Evidence ledger:
  - `<short label>`: `<path:line-line>` `<symbol/config/API/test/command>` - <fact this pointer supports>.
- Validation:
  - `<command or method>` - <pass/fail>; scope: <full/scoped/probe/not checked>; notes: <short error signature, blocker, or None>.
```

Omit empty nested labels when they do not add value.

Use `Validation` for acceptance-relevant checks. Do not record routine review/state-check commands or intermediate passing validation unless they expose a failure, blocker, open risk, unexpected side effect, or user-requested audit fact.

## Summary Protocol

Use when the user asks to summarize, compact, or clean up `task_state.md`.

Summary is a root-owned rewrite of `task_state.md`, not a report workflow. Do not create a report for summarization. Do not read archived reports during normal summary; archived reports are non-authoritative audit copies and may be unreadable or deleted.

Before rewriting `task_state.md`, run `status`, read `task_state.md`, and check pending reports. If pending reports overlap with the summary, absorb them or explicitly leave them pending before summarizing.

Ask for options before modifying `task_state.md`, unless already provided. Prefer `request_user_input`. Offer:

- Summary level:
  - `Balanced` (recommended): compact low-value detail; keep active decisions, key evidence, acceptance validation, and open work.
  - `Conservative`: remove only obvious repetition and stale noise.
  - `Aggressive`: keep only goal, phase, active decisions, blockers, next actions, and highest-signal evidence.
- Evidence retention:
  - `Hard pointers` (recommended): keep one path, symbol, command, test, URL, or error signature per active decision, risk, decision-bearing validation, or subsystem finding.
  - `Decision focused`: keep conclusions and minimal anti-rework evidence.
  - `Minimal`: keep evidence only for open risks, blockers, failing validation, public interfaces, or irreversible decisions.
- History handling:
  - `Collapse absorbed notes` (recommended): compact absorbed report notes and remove raw logs, routine validation/review/state-check history, repeated search output, abandoned hypotheses, and duplicate validation detail.
  - `Keep timeline`: preserve a compact chronological trail.
  - `Current state only`: discard completed-history detail unless it changes behavior, risk, acceptance validation, or next steps.

When applying a summary, preserve `# Task State`, `Goal`, `State`, `Open`, and `Reports`. The result must support resume without chat history, archived reports, or reopening absorbed reports; pending reports may remain only as notes under `Reports`. Do not discard blockers, pending report notes, active next actions, validation failures, final acceptance status, unexpected side effects, or evidence for open decisions. Remove routine validation/review/state-check history unless audit was requested.

## Resume Protocol

After compaction, handoff, or a long pause, root treats `task_state.md` as source of truth.

1. Run `status` for the workspace and task-id.
2. Read `task_state.md`.
3. Check pending reports listed by `status` and under `Reports`.
4. Absorb or explicitly leave pending any report that overlaps with the next planned work.
5. Continue from `Goal`, `State`, `Open`, and pending report notes, not from chat history alone.

Archived reports are audit history only. Do not read them during normal resume or depend on them.

## Scripts

Use bundled scripts for mechanical workflow steps.

Run commands from this skill directory, or replace `scripts/task_memory.py` with its absolute path. Run `init` only for a new task; for existing task memory, run `status` with the actual task-id.

```bash
python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
python scripts/task_memory.py archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
```

`init` creates `task_state.md`, `reports/`, and `reports/archive/`; if needed it appends `-001`, `-002`, etc. and prints `task_id=<actual-task-id>`.

`status` has no side effects and prints task/report paths plus pending and archived report lists.

`create-report` creates a report template and prints its absolute path. `--name` should be short hyphen-case or quoted English and is normalized to lowercase hyphen-case.

`archive-report` moves an absorbed report to `reports/archive/`, never edits `task_state.md`, and appends `-001`, `-002`, etc. rather than overwriting. `--report` takes the report filename only, not the absolute path returned by `create-report`.

Only root may run `archive-report`. Archive one filename at a time with the script; do not move reports with shell commands, wildcards, or directory operations.

Always pass an absolute `--workspace`.

## Brief Templates

Report-required subagent brief:

```text
Use $task-memory for this subtask. Follow the subagent protocol.

Task memory:
- workspace: <absolute workspace path>
- task-id: <task-id>
- report name: <short report name>
- task_memory.py: <absolute path to task_memory.py>

Run:
python <absolute path to task_memory.py> status --workspace <absolute workspace path> --task-id <task-id>

Read the returned task_state path.

Create your report before writing findings:
python <absolute path to task_memory.py> create-report --workspace <absolute workspace path> --task-id <task-id> --name <short report name>

Write to the generated report path.

Task:
<specific assignment>

Constraints:
- Do not modify task_state.md or source files unless explicitly assigned.
- Use the Report Shape from $task-memory; write an absorption-ready summary.
- Fill `Scope` with the assigned subtask and boundaries.
- Put only durable conclusions, decisions, risks, final/representative validation, failure signatures, unexpected side effects, and next actions into Absorbable Findings or Open or Not Checked.
- Omit routine validation, review, state-check, raw stdout, and repeated static-check detail unless durable.
- Start each evidence item with a hard pointer, then add at most one short fact.
- On success, return only the report path plus one high-level sentence, such as `Report written; conclusion: <one sentence>.`
- Do not use bullets or repeat report details in chat.
- If blocked, return only the reason, attempted command, and partial report path or `None`.
```

Command-only subagent brief:

```text
Use $task-memory only if task context is needed. This is a command-only handoff.

Task memory:
- workspace: <absolute workspace path>
- task-id: <task-id>
- task_memory.py: <absolute path to task_memory.py>

If needed, run:
python <absolute path to task_memory.py> status --workspace <absolute workspace path> --task-id <task-id>

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
