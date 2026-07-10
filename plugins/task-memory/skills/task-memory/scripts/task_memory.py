#!/usr/bin/env python3
"""Manage lightweight per-task memory folders."""

from __future__ import annotations

import argparse
import os
import re
import stat
from datetime import datetime
from pathlib import Path


REPORT_FILENAME_PATTERN = re.compile(r"^\d{8}-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")


def normalize_token(value: str, field_name: str) -> str:
    token = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    if not token:
        raise ValueError(f"{field_name} must contain at least one letter or digit")
    return token


def normalize_task_id(value: str) -> str:
    token = normalize_token(value, "--task-id")
    if not token.startswith("task-"):
        raise ValueError("--task-id must start with task-")
    return token


def resolve_workspace(value: str) -> Path:
    workspace = Path(value).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        raise SystemExit(f"workspace does not exist or is not a directory: {workspace}")
    return workspace


def is_link_or_reparse_point(path: Path) -> bool:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(path_stat.st_mode):
        return True
    return os.name == "nt" and bool(path_stat.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def is_managed_report(path: Path) -> bool:
    return bool(REPORT_FILENAME_PATTERN.fullmatch(path.name)) and not is_link_or_reparse_point(path) and path.is_file()


def validate_managed_path(workspace: Path, path: Path, label: str) -> None:
    if is_link_or_reparse_point(path):
        raise SystemExit(f"refusing {label} that is a symlink, junction, or reparse point: {path}")
    try:
        path.resolve().relative_to(workspace)
    except ValueError as error:
        raise SystemExit(f"{label} escapes workspace: {path}") from error


def task_memory_root_path(workspace: Path) -> Path:
    return workspace / "task-memory"


def task_dir_path(workspace: Path, normalized_task_id: str) -> Path:
    return task_memory_root_path(workspace) / normalized_task_id


def resolve_task_dir(workspace: Path, task_id: str, must_exist: bool = True) -> Path:
    normalized_task_id = normalize_task_id(task_id)
    task_dir = task_dir_path(workspace, normalized_task_id)
    if task_dir.is_dir() or not must_exist:
        return task_dir

    raise SystemExit(f"task not found: {normalized_task_id}")


def task_state_path(task_dir: Path) -> Path:
    return task_dir / "task_state.md"


def reports_dir_path(task_dir: Path) -> Path:
    return task_dir / "reports"


def artifacts_dir_path(task_dir: Path) -> Path:
    return task_dir / "artifacts"


def validate_task_dir(workspace: Path, task_dir: Path, require_reports: bool = True) -> tuple[Path, Path, Path]:
    task_state = task_state_path(task_dir)
    reports_dir = reports_dir_path(task_dir)
    artifacts_dir = artifacts_dir_path(task_dir)
    validate_managed_path(workspace, task_memory_root_path(workspace), "task memory root")
    validate_managed_path(workspace, task_dir, "task directory")
    validate_managed_path(workspace, reports_dir, "reports directory")
    validate_managed_path(workspace, artifacts_dir, "artifacts directory")
    if not task_state.is_file():
        raise SystemExit(f"missing task_state.md: {task_state}")
    if reports_dir.exists() and not reports_dir.is_dir():
        raise SystemExit(f"reports path exists but is not a directory: {reports_dir}")
    if require_reports and not reports_dir.is_dir():
        raise SystemExit(f"missing reports directory: {reports_dir}")
    if artifacts_dir.exists() and not artifacts_dir.is_dir():
        raise SystemExit(f"artifacts path exists but is not a directory: {artifacts_dir}")
    return task_state, reports_dir, artifacts_dir


def task_state_template() -> str:
    return """# Task State

## Goal

- Objective: TBD
- Success criteria: TBD

## State

- Phase: initialized

## Open

- Next: define the objective and first concrete action.

## Reports

- None
"""


def next_sequence(reports_dir: Path, date: str) -> int:
    pattern = re.compile(rf"^{re.escape(date)}-(\d{{3}})-")
    max_sequence = 0
    for path in reports_dir.glob(f"{date}-*.md"):
        if not is_managed_report(path):
            continue
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


def report_template(report_name: str) -> str:
    created = datetime.now().isoformat(timespec="seconds")
    return f"""# {title_from_token(report_name)} Report

Scope: TBD
Status: in-progress
Last updated: {created}

## Conclusion

- TBD

## Findings

- TBD. Evidence: not checked.

## Open

- None
"""


def create_report_file(reports_dir: Path, report_name: str) -> Path:
    date = datetime.now().strftime("%Y%m%d")
    sequence = next_sequence(reports_dir, date)
    while sequence < 1000:
        report = reports_dir / f"{date}-{sequence:03d}-{report_name}.md"
        try:
            with report.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(report_template(report_name))
            return report
        except FileExistsError:
            sequence += 1
    raise SystemExit(f"could not allocate report filename for date {date}: {reports_dir}")


def resolve_live_report(reports_dir: Path, report_value: str) -> Path:
    report_path = Path(report_value).expanduser()
    if report_path.is_absolute():
        candidate = report_path
    else:
        candidate = reports_dir / report_path
    if candidate.parent.resolve() != reports_dir.resolve():
        raise SystemExit(f"refusing to delete a report outside the live reports directory: {candidate}")
    if not is_managed_report(candidate):
        if not REPORT_FILENAME_PATTERN.fullmatch(candidate.name):
            raise SystemExit(f"invalid report filename: {candidate.name}")
        if is_link_or_reparse_point(candidate):
            raise SystemExit(f"refusing report symlink or reparse point: {candidate}")
        raise SystemExit(f"report does not exist: {candidate}")
    return candidate


def command_init(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_id = normalize_task_id(args.task_id)
    validate_managed_path(workspace, task_memory_root_path(workspace), "task memory root")
    actual_task_id, task_dir = allocate_task_dir(workspace, task_id)
    validate_managed_path(workspace, task_dir, "task directory")
    reports_dir = reports_dir_path(task_dir)
    artifacts_dir = artifacts_dir_path(task_dir)
    task_state = task_state_path(task_dir)

    reports_dir.mkdir(parents=True)
    artifacts_dir.mkdir()
    task_state.write_text(task_state_template(), encoding="utf-8", newline="\n")

    print(f"task_id={actual_task_id}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    _task_state, reports_dir, _artifacts_dir = validate_task_dir(workspace, task_dir, require_reports=False)
    live_reports = (
        sorted(path for path in reports_dir.glob("*.md") if is_managed_report(path))
        if reports_dir.is_dir()
        else []
    )

    report_names = ",".join(report.name for report in live_reports)
    print(f"reports={report_names or 'none'}")
    return 0


def command_create_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    _task_state, reports_dir, _artifacts_dir = validate_task_dir(workspace, task_dir, require_reports=False)
    reports_dir.mkdir(exist_ok=True)
    report_name = normalize_token(args.name, "--name")
    report = create_report_file(reports_dir, report_name)

    print(f"report={report.name}")
    return 0


def command_delete_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    _task_state, reports_dir, _artifacts_dir = validate_task_dir(workspace, task_dir, require_reports=False)
    reports_dir.mkdir(exist_ok=True)
    report = resolve_live_report(reports_dir, args.report)

    report.unlink()
    print(f"deleted={report.name}")
    return 0


def add_common_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", required=True, help="Absolute workspace path.")
    parser.add_argument("--task-id", required=True, help="Task id beginning with task-.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage task memory.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="Create task memory.")
    add_common_task_args(init_parser)
    init_parser.set_defaults(func=command_init)

    status_parser = subparsers.add_parser("status", help="List live reports.")
    add_common_task_args(status_parser)
    status_parser.set_defaults(func=command_status)

    create_report_parser = subparsers.add_parser("create-report", help="Create report.")
    add_common_task_args(create_report_parser)
    create_report_parser.add_argument("--name", required=True, help="Report name.")
    create_report_parser.set_defaults(func=command_create_report)

    delete_report_parser = subparsers.add_parser("delete-report", help="Delete report.")
    add_common_task_args(delete_report_parser)
    delete_report_parser.add_argument("--report", required=True, help="Report filename.")
    delete_report_parser.set_defaults(func=command_delete_report)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
