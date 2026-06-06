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


def task_memory_root_path(workspace: Path) -> Path:
    return workspace / "task-memory"


def task_dir_path(workspace: Path, normalized_task_id: str) -> Path:
    return task_memory_root_path(workspace) / f"task-{normalized_task_id}"


def available_task_names(task_parent: Path) -> list[str]:
    return sorted(path.name for path in task_parent.glob("task-*") if path.is_dir())


def task_dir_not_found_hint(workspace: Path) -> str:
    task_memory_root = task_memory_root_path(workspace)
    tasks = available_task_names(task_memory_root)
    hint = f"Tasks: {', '.join(tasks)}" if tasks else "No task-memory/task-* directories found."
    return f" {hint}"


def resolve_task_dir(workspace: Path, task_id: str, must_exist: bool = True) -> Path:
    normalized_task_id = normalize_token(task_id, "--task-id")
    task_dir = task_dir_path(workspace, normalized_task_id)
    if task_dir.is_dir() or not must_exist:
        return task_dir

    hint = task_dir_not_found_hint(workspace)
    raise SystemExit(f"task memory folder not found: {task_dir}.{hint}")


def task_state_path(task_dir: Path) -> Path:
    return task_dir / "task_state.md"


def reports_dir_path(task_dir: Path) -> Path:
    return task_dir / "reports"


def archive_dir_path(task_dir: Path) -> Path:
    return reports_dir_path(task_dir) / "archive"


def validate_task_dir(task_dir: Path) -> tuple[Path, Path, Path]:
    task_state = task_state_path(task_dir)
    reports_dir = reports_dir_path(task_dir)
    archive_dir = archive_dir_path(task_dir)
    if not task_state.is_file():
        raise SystemExit(f"missing task_state.md: {task_state}")
    if not reports_dir.is_dir():
        raise SystemExit(f"missing reports directory: {reports_dir}")
    if archive_dir.exists() and not archive_dir.is_dir():
        raise SystemExit(f"reports archive path exists but is not a directory: {archive_dir}")
    archive_dir.mkdir(exist_ok=True)
    return task_state, reports_dir, archive_dir


def task_state_template(task_name: str) -> str:
    return f"""# Task State

## Goal

- Task: {task_name}
- Success criteria: TBD

## State

- Current phase: initialization
- Durable findings:
  - Task memory folder created — evidence: task_state.md, reports/, and reports/archive/ initialized; validation: scaffold only.
- Evidence ledger:
  - `task-memory-init`: task_state.md + reports/ + reports/archive/ — initial durable memory scaffold.
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


def allocate_task_dir(workspace: Path, task_id: str) -> tuple[str, Path]:
    task_dir = task_dir_path(workspace, task_id)
    if not task_dir.exists():
        return task_id, task_dir
    sequence = 1
    while sequence < 1000:
        candidate_task_id = f"{task_id}-{sequence:03d}"
        candidate = task_dir_path(workspace, candidate_task_id)
        if not candidate.exists():
            return candidate_task_id, candidate
        sequence += 1
    raise SystemExit(f"could not allocate task memory folder for task id: {task_id}")


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

## Absorbable Findings

- `<finding>` Evidence: `<path:line-line>` `<symbol/config/API/test/command>` - TBD

## Open or Not Checked

- N/A

## Role Result

- N/A
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


def resolve_pending_report(reports_dir: Path, report_value: str) -> Path:
    report_path = Path(report_value).expanduser()
    if report_path.is_absolute():
        candidate = report_path.resolve()
    else:
        candidate = (reports_dir / report_path).resolve()
    if not candidate.is_file():
        raise SystemExit(f"report does not exist: {candidate}")
    if candidate.suffix != ".md":
        raise SystemExit(f"refusing to archive a non-markdown report: {candidate}")
    if candidate.parent != reports_dir.resolve():
        raise SystemExit(f"refusing to archive a report outside the pending reports directory: {candidate}")
    return candidate


def next_archive_path(archive_dir: Path, report_name: str) -> Path:
    initial = archive_dir / report_name
    if not initial.exists():
        return initial
    stem = initial.stem
    suffix = initial.suffix
    sequence = 1
    while sequence < 1000:
        candidate = archive_dir / f"{stem}-{sequence:03d}{suffix}"
        if not candidate.exists():
            return candidate
        sequence += 1
    raise SystemExit(f"could not allocate archived report filename for: {report_name}")


def command_init(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_id = normalize_token(args.task_id, "--task-id")
    actual_task_id, task_dir = allocate_task_dir(workspace, task_id)
    reports_dir = reports_dir_path(task_dir)
    archive_dir = archive_dir_path(task_dir)
    task_state = task_state_path(task_dir)

    archive_dir.mkdir(parents=True)
    task_state.write_text(task_state_template(f"task-{actual_task_id}"), encoding="utf-8", newline="\n")

    print(f"task_id={actual_task_id}")
    print(f"task_dir={task_dir}")
    print(f"task_state={task_state}")
    print(f"reports_dir={reports_dir}")
    print(f"archive_dir={archive_dir}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir, archive_dir = validate_task_dir(task_dir)
    pending_reports = sorted(reports_dir.glob("*.md"))
    archived_reports = sorted(archive_dir.glob("*.md"))

    print(f"task_dir={task_dir}")
    print(f"task_state={task_state}")
    print(f"reports_dir={reports_dir}")
    print(f"archive_dir={archive_dir}")
    print(f"pending_reports={len(pending_reports)}")
    for report in pending_reports:
        print(f"pending_report={report.name}|{report}")
    print(f"archived_reports={len(archived_reports)}")
    for report in archived_reports:
        print(f"archived_report={report.name}|{report}")
    return 0


def command_create_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir, _archive_dir = validate_task_dir(task_dir)
    report_name = normalize_token(args.name, "--name")
    report = create_report_file(reports_dir, report_name, task_state)

    print(report)
    return 0


def command_archive_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    task_state, reports_dir, archive_dir = validate_task_dir(task_dir)
    report = resolve_pending_report(reports_dir, args.report)
    archive_target = next_archive_path(archive_dir, report.name)

    print(f"Task state: {task_state}")
    print(f"Report to archive: {report}")
    print(f"Archive target: {archive_target}")
    print("Before archiving, the task-state owner must fully absorb durable report content into task_state.md.")
    print("Archive gate: conclusion, evidence pointers, flow, validation, risks, and next actions are either absorbed, intentionally discarded as non-durable, or left pending.")
    print("Archived reports are best-effort audit copies and may later be unreadable or deleted.")

    report.rename(archive_target)
    print(f"Archived: {archive_target}")
    return 0


def add_common_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", required=True, help="Absolute workspace path containing the task-memory/task-<task-id> folders.")
    parser.add_argument("--task-id", required=True, help="Workspace-unique task id, normalized to lowercase hyphen-case.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage task-memory/task-<task-id>/task_state.md, reports/, and reports/archive/.",
        epilog="""Examples:
  python scripts/task_memory.py init --workspace <absolute-workspace> --task-id <task-id>
  python scripts/task_memory.py status --workspace <absolute-workspace> --task-id <task-id>
  python scripts/task_memory.py create-report --workspace <absolute-workspace> --task-id <task-id> --name thumbnail-cache-check
  python scripts/task_memory.py archive-report --workspace <absolute-workspace> --task-id <task-id> --report <report-filename>
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Create a task memory folder.")
    add_common_task_args(init_parser)
    init_parser.set_defaults(func=command_init)

    status_parser = subparsers.add_parser("status", help="Print task memory paths, pending reports, and archived reports.")
    add_common_task_args(status_parser)
    status_parser.set_defaults(func=command_status)

    create_report_parser = subparsers.add_parser("create-report", help="Create a pending report template.")
    add_common_task_args(create_report_parser)
    create_report_parser.add_argument("--name", required=True, help="Short report name, normalized to lowercase hyphen-case.")
    create_report_parser.set_defaults(func=command_create_report)

    archive_report_parser = subparsers.add_parser("archive-report", help="Archive an absorbed report from reports/.")
    add_common_task_args(archive_report_parser)
    archive_report_parser.add_argument("--report", required=True, help="Report filename under reports/. Archive one absorbed report at a time.")
    archive_report_parser.set_defaults(func=command_archive_report)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
