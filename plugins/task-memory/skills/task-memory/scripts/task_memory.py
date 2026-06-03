#!/usr/bin/env python3
"""Manage lightweight per-task memory folders."""

from __future__ import annotations

import argparse
import re
from datetime import datetime
from pathlib import Path


def normalize_token(value: str, field_name: str) -> str:
    token = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    if not token:
        raise ValueError(f"{field_name} must contain at least one letter or digit")
    return token


def resolve_workspace(value: str) -> Path:
    workspace = Path(value).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        raise SystemExit(f"workspace does not exist or is not a directory: {workspace}")
    return workspace


def resolve_task_dir(workspace: Path, task_id: str, must_exist: bool = True) -> Path:
    normalized_task_id = normalize_token(task_id, "--task-id")
    task_dir = workspace / f"task-{normalized_task_id}"
    if must_exist and not task_dir.is_dir():
        available = sorted(path.name for path in workspace.glob("task-*") if path.is_dir())
        hint = f" Available tasks: {', '.join(available)}" if available else " No task-* directories found."
        raise SystemExit(f"task memory folder not found: {task_dir}.{hint}")
    return task_dir


def task_state_path(task_dir: Path) -> Path:
    return task_dir / "task_state.md"


def reports_dir_path(task_dir: Path) -> Path:
    return task_dir / "reports"


def validate_task_dir(task_dir: Path) -> tuple[Path, Path]:
    task_state = task_state_path(task_dir)
    reports_dir = reports_dir_path(task_dir)
    if not task_state.is_file():
        raise SystemExit(f"missing task_state.md: {task_state}")
    if not reports_dir.is_dir():
        raise SystemExit(f"missing reports directory: {reports_dir}")
    return task_state, reports_dir


def task_state_template(task_name: str) -> str:
    return f"""# Task State

## Goal

- Task: {task_name}
- Success criteria: TBD

## State

- Current phase: initialization
- Durable findings:
  - Task memory folder created — evidence: task_state.md and reports/ initialized; validation: scaffold only.
- Evidence ledger:
  - `task-memory-init`: task_state.md + reports/ — initial durable memory scaffold.
- Validation:
  - scaffold creation — pass; scope: scaffold only; notes: no task work validated yet.

## Open

- Fill in the task goal, success criteria, and first concrete next step.

## Reports

Pending:
- none

Absorbed:
- none
"""


def next_sequence(reports_dir: Path, date: str) -> int:
    pattern = re.compile(rf"^{re.escape(date)}-(\d{{3}})-")
    max_sequence = 0
    for path in reports_dir.glob(f"{date}-*.md"):
        match = pattern.match(path.name)
        if match:
            max_sequence = max(max_sequence, int(match.group(1)))
    return max_sequence + 1


def title_from_token(token: str) -> str:
    return " ".join(part.capitalize() for part in token.split("-"))


def report_template(report_name: str, task_state: Path) -> str:
    created = datetime.now().isoformat(timespec="seconds")
    return f"""# {title_from_token(report_name)} Report

Created: {created}
Task state read: {task_state}
Scope: TBD
Repo/context snapshot: not checked

## Conclusion

- TBD

## Evidence

- `<path:line-line>` `<symbol/config/API/test/command>` - TBD

## Data or Control Flow

- N/A

## Validation

- `<command or method>` - not run; scope: not checked; relevant output or error signature: None

## Open Risks

- TBD

## Suggested Task State Update

- `<finding>` - evidence: `<path:line-line>` `<symbol/test/command>`; validation/risk: TBD
"""


def create_report_file(reports_dir: Path, report_name: str, task_state: Path) -> Path:
    date = datetime.now().strftime("%Y%m%d")
    sequence = next_sequence(reports_dir, date)
    while sequence < 1000:
        report = reports_dir / f"{date}-{sequence:03d}-{report_name}.md"
        try:
            with report.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(report_template(report_name, task_state))
            return report
        except FileExistsError:
            sequence += 1
    raise SystemExit(f"could not allocate report filename for date {date}: {reports_dir}")


def resolve_report(reports_dir: Path, report_value: str) -> Path:
    report_path = Path(report_value).expanduser()
    if report_path.is_absolute():
        candidate = report_path.resolve()
    else:
        candidate = (reports_dir / report_path).resolve()
    if not candidate.is_file():
        raise SystemExit(f"report does not exist: {candidate}")
    if candidate.suffix != ".md":
        raise SystemExit(f"refusing to delete a non-markdown report: {candidate}")
    if reports_dir.resolve() not in candidate.parents:
        raise SystemExit(f"refusing to delete a report outside reports/: {candidate}")
    return candidate


def command_init(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_id = normalize_token(args.task_id, "--task-id")
    task_dir = resolve_task_dir(workspace, task_id, must_exist=False)
    reports_dir = reports_dir_path(task_dir)
    task_state = task_state_path(task_dir)

    if task_dir.exists():
        raise SystemExit(f"task memory folder already exists: {task_dir}")

    reports_dir.mkdir(parents=True)
    task_state.write_text(task_state_template(f"task-{task_id}"), encoding="utf-8", newline="\n")

    print(f"task_dir={task_dir}")
    print(f"task_state={task_state}")
    print(f"reports_dir={reports_dir}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir = validate_task_dir(task_dir)
    pending_reports = sorted(reports_dir.glob("*.md"))

    print(f"task_dir={task_dir}")
    print(f"task_state={task_state}")
    print(f"reports_dir={reports_dir}")
    print(f"pending_reports={len(pending_reports)}")
    for report in pending_reports:
        print(f"pending_report={report.name}|{report}")
    return 0


def command_create_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir = validate_task_dir(task_dir)
    report_name = normalize_token(args.name, "--name")
    report = create_report_file(reports_dir, report_name, task_state)

    print(report)
    return 0


def command_delete_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir = validate_task_dir(task_dir)
    report = resolve_report(reports_dir, args.report)

    print(f"Task state: {task_state}")
    print(f"Report to delete: {report}")
    print("Before deletion, root must fully absorb durable report content into task_state.md.")
    print("Deletion gate: conclusion, evidence pointers, flow, validation, risks, and next actions are either absorbed, intentionally discarded as non-durable, or left pending.")

    report.unlink()
    print(f"Deleted: {report}")
    return 0


def add_common_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", required=True, help="Absolute workspace path containing task-<task-id> folders.")
    parser.add_argument("--task-id", required=True, help="Workspace-unique task id, normalized to lowercase hyphen-case.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage task-<task-id>/task_state.md and reports/.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Create a task memory folder.")
    add_common_task_args(init_parser)
    init_parser.set_defaults(func=command_init)

    status_parser = subparsers.add_parser("status", help="Print task memory paths and pending report status.")
    add_common_task_args(status_parser)
    status_parser.set_defaults(func=command_status)

    create_report_parser = subparsers.add_parser("create-report", help="Create a pending report template.")
    add_common_task_args(create_report_parser)
    create_report_parser.add_argument("--name", required=True, help="Short report name, normalized to lowercase hyphen-case.")
    create_report_parser.set_defaults(func=command_create_report)

    delete_report_parser = subparsers.add_parser("delete-report", help="Delete an absorbed report from reports/.")
    add_common_task_args(delete_report_parser)
    delete_report_parser.add_argument("--report", required=True, help="Report filename under reports/. Delete one absorbed report at a time.")
    delete_report_parser.set_defaults(func=command_delete_report)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
