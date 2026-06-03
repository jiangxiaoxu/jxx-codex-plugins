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

Root updates `task_state.md` directly whenever durable task memory changes: goal or scope changes, stable decisions, completed root work, important evidence, validation results, blockers, open questions, and absorbed subagent reports.

Do not route root's own work through `reports/` unless the user explicitly asks for a handoff or audit artifact.

Subagents never edit `task_state.md`. Choose the handoff mode by task shape, not by agent type:

- Use a report-required handoff for exploration, implementation, impact analysis, call tracing, decision support, durable evidence collection, or any subtask whose result should survive context compaction as independent evidence.
- Use a command-only handoff only when the subtask executes parent-specified commands and returns command results, exit status, scoped output, or short error signatures without independent exploration, implementation, or durable analysis.

For report-required handoffs, the subagent activates/reads this skill first, runs `status`, reads `task_state.md`, does the assigned work, creates one report in `reports/`, writes the report, and returns only the report path plus one high-level sentence summarizing the result to root.

For command-only handoffs, the subagent may run `status` if it needs task context, but it does not run `create-report` and does not write to `reports/`. It returns results in chat. Root decides whether any command result is durable enough to write into `task_state.md`.

Reports are temporary inbox items. After root fully absorbs a report into `task_state.md`, root archives the report under `reports/archive/`. Keep only a short absorbed-report note in `task_state.md`. Full absorption means the task can resume from `task_state.md` without reopening or regenerating the report for the same decision.

Archived reports are best-effort audit copies, not durable state. They may become unreadable or be deleted by later cleanup. Never rely on an archived report to resume work; preserve everything needed to continue in `task_state.md` before archiving.

Before dispatching a report-required subagent:

1. Update `task_state.md` with the latest goal, state, open items, and pending reports.
2. Explicitly activate this skill for the subagent with `Use $task-memory` at the start of the brief, and pass the skill as a structured skill item when the tool supports it.
3. Include the absolute workspace path, `task-id`, and suggested report name in the subagent brief.
4. Tell the subagent to run `status`, read `task_state.md`, run `create-report`, write the generated report, and return only the report path plus one high-level sentence summarizing the result.
5. Tell the subagent not to modify `task_state.md`.

After a report-required subagent finishes:

1. Read the report from `reports/` in full. Do not rely only on returned key points.
2. Absorb durable content into `task_state.md` using the absorption rules below.
3. If anything remains unabsorbed, keep the report in `reports/` and add a short `Reports > Pending` note explaining what remains.
4. When absorption is complete, add one short `Reports > Absorbed` entry with the report filename, headline conclusion, and where the durable content was absorbed in `State`.
5. Archive only a fully absorbed report. Do not archive a report merely because its headline conclusion was copied.

## Absorption Rules

Keep `task_state.md` compact, but preserve enough hard pointers and findings to prevent repeated exploration after context compaction. Preserve one durable evidence item per independent subsystem, decision, risk, or validation result; combine related pointers when possible, but do not drop hard evidence only to keep the entry short.

When absorbing a report, use `Conclusion`, `Absorbable Findings`, and `Open or Not Checked` as the source. Preserve durable items:

- Stable conclusion, decision, risk, validation result, or failure status.
- Exact evidence pointers: `path:line-line`, symbol/function/class names, config keys, query names, API fields, command names, test names, source URLs, or error signatures.
- One short fact after an evidence pointer when it helps root absorb without reopening the source immediately.
- Remaining uncertainty, blocker, not-checked validation, and next action.

Move remaining risks, blockers, uncertainties, and next actions into `Open`.

Before archiving a report, each durable item must be represented in `task_state.md`, intentionally discarded as non-durable, or left unabsorbed with the report still pending. If an item looks like durable evidence but is intentionally discarded, note the reason briefly in the absorbed report note or `Open`. Usually discard raw stdout, large diffs, repetitive search output, reasoning traces, dead-end exploration, abandoned hypotheses, and duplicate evidence after their durable conclusion has been captured.

A report is adequately absorbed only when another agent can continue from `task_state.md` without reopening or regenerating that report for the same decision, even if the archived report is unreadable or has been deleted.

For command-only handoffs, do not create a synthetic absorbed-report note. If the command result is durable, root records it directly under `State` or `Open` with the command, result, scope, and short error signature when relevant. If it is not durable, leave it in chat only.

## Report Shape

Ask subagents to write absorption-ready summaries, not detailed audit logs. Use `None`, `N/A`, or `Not checked` when a section does not apply. Prefer 1-5 high-signal bullets total over exhaustive detail.

Each absorbable finding should be suitable to copy or condense into `task_state.md`. Evidence must start with a hard pointer, then may include at most one short fact. Do not paste raw stdout, large diffs, search output, reasoning process, dead-end hypotheses, duplicate evidence, or information root is unlikely to absorb.

````markdown
# <Report Title>

Created: <timestamp>
Task state read: <absolute task_state.md path>
Scope: <assigned subtask and explicit boundaries>
Repo/context snapshot: <commit, branch, timestamp, or "not checked">

## Conclusion

- <1-2 bullets with the direct answer, decision, or failure status.>

## Absorbable Findings

- <Finding, decision, risk, or validation result.> Evidence: `<path:line-line>` `<symbol/config/API/test/command>` - <one short fact>.
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

## Summary Protocol

Use this protocol when the user invokes this skill with words like `summary`, `summarize`, `compact`, `总结`, `整理`, or `精简`, or otherwise asks to summarize `task_state.md`.

Summary is a root-owned rewrite of `task_state.md`, not a report workflow. Do not create a report for summarization. Do not read archived reports during normal summary; archived reports are non-authoritative audit copies and may be unreadable or deleted.

Before rewriting `task_state.md`, run `status`, read `task_state.md`, and check pending reports. If pending reports overlap with the summary, absorb them or explicitly leave them pending before summarizing.

Ask the user for summary options before modifying `task_state.md`, unless the user already provided equivalent choices. Prefer `request_user_input` when available. Offer these choices:

- Summary level:
  - `Balanced` (recommended): compact duplicated history and low-value detail, keep active decisions, key evidence pointers, validation status, and open work.
  - `Conservative`: remove only obvious repetition and stale noise, preserving most evidence ledger and report history.
  - `Aggressive`: keep only the goal, current phase, active decisions, blockers, next actions, and highest-signal evidence.
- Evidence retention:
  - `Hard pointers` (recommended): keep at least one path, symbol, command, test, source URL, or error signature per active decision, risk, validation result, or subsystem finding.
  - `Decision focused`: keep conclusions and only the minimal evidence needed to avoid rework.
  - `Minimal`: keep evidence only for open risks, blockers, failing validation, public interfaces, or irreversible decisions.
- History handling:
  - `Archive absorbed notes` (recommended): collapse absorbed report notes to short one-line history and remove raw logs, repeated search output, abandoned hypotheses, and duplicate validation details.
  - `Keep timeline`: preserve a compact chronological trail for handoff or audit needs.
  - `Current state only`: discard completed-history detail unless it changes current behavior, risk, validation, or next steps.

When applying a summary, preserve the `# Task State`, `Goal`, `State`, `Open`, and `Reports` sections. The resulting `task_state.md` must be sufficient to resume the task without chat history, pending reports that were absorbed, or archived reports. Do not discard unresolved blockers, pending report notes, active next actions, validation failures, or evidence for open decisions.

## Resume Protocol

After context compaction, handoff, or a long pause, root must treat `task_state.md` as the source of truth.

1. Run `status` for the workspace and task-id.
2. Read `task_state.md`.
3. Check pending reports listed by `status` and under `Reports`.
4. Absorb or explicitly leave pending any report that overlaps with the next planned work.
5. Continue from `Goal`, `State`, `Open`, and pending report notes, not from chat history alone.

Archived reports listed by `status` are audit history only. Do not read them during normal resume, and do not depend on them being readable or present.

## Scripts

Use bundled scripts for the mechanical parts of the workflow.

```bash
python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
python scripts/task_memory.py archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
```

`init` creates `task_state.md`, `reports/`, and `reports/archive/`. If the requested `--task-id` already exists, it creates the next available `-001`, `-002`, etc. variant and prints `task_id=<actual-task-id>`.

`status` has no side effects. It prints `task_dir`, `task_state`, `reports_dir`, `archive_dir`, `pending_reports`, any existing `pending_report` paths, `archived_reports`, and any existing `archived_report` paths.

`create-report` creates a report template and prints its absolute path. The `--name` value should be a short hyphen-case or quoted English phrase and is normalized to lowercase hyphen-case.

`archive-report` moves an already absorbed report from `reports/` to `reports/archive/` and does not edit `task_state.md`. Root must absorb the report manually before archiving. If the archive target filename already exists, the script appends `-001`, `-002`, etc. and never overwrites an existing archived report.

Only root may run `archive-report`. Subagents must never archive reports. Archive reports one filename at a time using the script; do not move reports with shell commands, wildcards, or directory operations.

Always pass an absolute path to `--workspace`. The script can resolve relative paths, but absolute paths are more reliable across subagents, handoffs, and context compaction.

## Brief Templates

Use this shape when dispatching a report-required subagent:

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
- Write an absorption-ready summary, not a detailed audit log.
- Fill `Scope` with the assigned subtask and explicit boundaries.
- Put only durable conclusions, decisions, risks, validation results, and next actions into Absorbable Findings or Open or Not Checked.
- Start each evidence item with a hard pointer, then add at most one short fact.
- On success, return only the generated report absolute path plus one high-level summary sentence, such as `Report written; conclusion: <one sentence>.`
- Do not use bullets in the chat return. Do not repeat Absorbable Findings or Open or Not Checked details in chat.
- If you cannot create or write the report, return only a short failure note with the reason, the command attempted, and any partial report path or `None`.
```

Use this shape when dispatching a command-only subagent:

```text
Use $task-memory for this subtask only if you need task context. This is a command-only handoff.

Task memory:
- workspace: <absolute workspace path>
- task-id: <task-id>

If task context is needed, start by running:
python scripts/task_memory.py status --workspace <absolute workspace path> --task-id <task-id>

Then read the returned task_state path.

Do not run create-report. Do not write a report file. Do not modify task_state.md.

Task:
<specific command execution assignment>

Constraints:
- Run only the assigned command family and directly necessary observation commands.
- Do not modify source files unless explicitly assigned.
- Do not perform independent exploration, implementation, impact analysis, or decision support.
- Return command, cwd, pass/fail status, exit code when available, scope, and the shortest useful stdout/stderr excerpt or error signature.
- Return results in chat only.
```
