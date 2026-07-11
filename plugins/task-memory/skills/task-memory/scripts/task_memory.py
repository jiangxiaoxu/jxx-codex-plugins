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
    workspace_argument = Path(value)
    if not workspace_argument.is_absolute():
        raise ValueError(f"--workspace must be an absolute path: {value}")
    workspace = workspace_argument.resolve()
    if not workspace.is_dir():
        raise ValueError(f"workspace does not exist or is not a directory: {workspace}")
    return workspace


def path_metadata(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def is_link_or_reparse_point(metadata: os.stat_result) -> bool:
    if stat.S_ISLNK(metadata.st_mode):
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(getattr(metadata, "st_file_attributes", 0) & reparse_flag)


def ensure_within_workspace(workspace: Path, path: Path, label: str) -> None:
    try:
        path.relative_to(workspace)
    except ValueError as error:
        raise ValueError(f"{label} escapes workspace: {path}") from error


def validate_directory(workspace: Path, path: Path, label: str) -> None:
    ensure_within_workspace(workspace, path, label)
    metadata = path_metadata(path)
    if metadata is None:
        raise ValueError(f"missing {label}: {path}")
    if is_link_or_reparse_point(metadata):
        raise ValueError(f"refusing {label} that is a symlink, junction, or reparse point: {path}")
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"{label} is not a directory: {path}")


def validate_regular_file(workspace: Path, path: Path, label: str) -> None:
    ensure_within_workspace(workspace, path, label)
    metadata = path_metadata(path)
    if metadata is None:
        raise ValueError(f"missing {label}: {path}")
    if is_link_or_reparse_point(metadata):
        raise ValueError(f"refusing {label} symlink or reparse point: {path}")
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} is not a regular file: {path}")
    if metadata.st_nlink != 1:
        raise ValueError(f"refusing hard-linked {label}: {path}")


def task_memory_root_path(workspace: Path) -> Path:
    return workspace / "task-memory"


def task_dir_path(workspace: Path, normalized_task_id: str) -> Path:
    return task_memory_root_path(workspace) / normalized_task_id


def task_state_path(task_dir: Path) -> Path:
    return task_dir / "task_state.md"


def reports_dir_path(task_dir: Path) -> Path:
    return task_dir / "reports"


def artifacts_dir_path(task_dir: Path) -> Path:
    return task_dir / "artifacts"


def validate_task_dir(workspace: Path, task_dir: Path) -> tuple[Path, Path, Path]:
    task_root = task_memory_root_path(workspace)
    task_state = task_state_path(task_dir)
    reports_dir = reports_dir_path(task_dir)
    artifacts_dir = artifacts_dir_path(task_dir)
    validate_directory(workspace, task_root, "task memory root")
    validate_directory(workspace, task_dir, "task directory")
    validate_regular_file(workspace, task_state, "task_state.md")
    validate_directory(workspace, reports_dir, "reports directory")
    validate_directory(workspace, artifacts_dir, "artifacts directory")
    return task_state, reports_dir, artifacts_dir


def resolve_task_dir(workspace: Path, task_id: str) -> Path:
    normalized_task_id = normalize_task_id(task_id)
    task_dir = task_dir_path(workspace, normalized_task_id)
    if path_metadata(task_dir) is None:
        raise ValueError(f"task not found: {normalized_task_id}")
    validate_task_dir(workspace, task_dir)
    return task_dir


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


def managed_report_metadata(path: Path) -> os.stat_result | None:
    if not REPORT_FILENAME_PATTERN.fullmatch(path.name):
        return None
    metadata = path_metadata(path)
    if metadata is None:
        return None
    if is_link_or_reparse_point(metadata):
        raise ValueError(f"refusing report symlink or reparse point: {path}")
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"managed report is not a regular file: {path}")
    if metadata.st_nlink != 1:
        raise ValueError(f"refusing hard-linked managed report: {path}")
    return metadata


def live_reports(reports_dir: Path) -> list[Path]:
    reports: list[Path] = []
    for path in reports_dir.iterdir():
        if managed_report_metadata(path) is not None:
            reports.append(path)
    return sorted(reports)


def next_sequence(reports_dir: Path, date: str) -> int:
    pattern = re.compile(rf"^{re.escape(date)}-(\d{{3}})-")
    max_sequence = 0
    for path in live_reports(reports_dir):
        match = pattern.match(path.name)
        if match:
            max_sequence = max(max_sequence, int(match.group(1)))
    return max_sequence + 1


def allocate_task_dir(workspace: Path, task_id: str) -> tuple[str, Path]:
    for sequence in range(1000):
        candidate_task_id = task_id if sequence == 0 else f"{task_id}-{sequence:03d}"
        candidate = task_dir_path(workspace, candidate_task_id)
        metadata = path_metadata(candidate)
        if metadata is None:
            return candidate_task_id, candidate
        validate_directory(workspace, candidate, "existing task directory")
    raise ValueError(f"could not allocate task memory folder for task id: {task_id}")


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
            managed_report_metadata(report)
            sequence += 1
    raise ValueError(f"could not allocate report filename for date {date}: {reports_dir}")


def resolve_live_report(workspace: Path, reports_dir: Path, report_value: str) -> Path:
    report_path = Path(report_value)
    candidate = report_path if report_path.is_absolute() else reports_dir / report_path
    ensure_within_workspace(workspace, candidate, "report")
    if candidate.parent != reports_dir:
        raise ValueError(f"refusing to delete a report outside the live reports directory: {candidate}")
    if not REPORT_FILENAME_PATTERN.fullmatch(candidate.name):
        raise ValueError(f"invalid report filename: {candidate.name}")
    if managed_report_metadata(candidate) is None:
        raise ValueError(f"report does not exist: {candidate}")
    return candidate


def command_init(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_id = normalize_task_id(args.task_id)
    task_root = task_memory_root_path(workspace)
    if path_metadata(task_root) is None:
        task_root.mkdir()
    validate_directory(workspace, task_root, "task memory root")

    actual_task_id, task_dir = allocate_task_dir(workspace, task_id)
    task_dir.mkdir()
    reports_dir_path(task_dir).mkdir()
    artifacts_dir_path(task_dir).mkdir()
    with task_state_path(task_dir).open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(task_state_template())
    validate_task_dir(workspace, task_dir)

    print(f"task_id={actual_task_id}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    reports = live_reports(reports_dir_path(task_dir))
    report_names = ",".join(report.name for report in reports)
    print(f"reports={report_names or 'none'}")
    return 0


def command_create_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    report_name = normalize_token(args.name, "--name")
    report = create_report_file(reports_dir_path(task_dir), report_name)

    print(f"report={report.name}")
    return 0


def command_delete_report(args: argparse.Namespace) -> int:
    workspace = resolve_workspace(args.workspace)
    task_dir = resolve_task_dir(workspace, args.task_id)
    report = resolve_live_report(workspace, reports_dir_path(task_dir), args.report)

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
    try:
        return args.func(args)
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
