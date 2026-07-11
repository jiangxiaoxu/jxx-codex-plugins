from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HELPER = (
    Path(__file__).parents[1]
    / "skills"
    / "task-memory"
    / "scripts"
    / "task_memory.py"
)


class TaskMemoryCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary_directory.name).resolve()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def run_helper(
        self, command: str, *arguments: str, expected_returncode: int = 0
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [
                sys.executable,
                os.fspath(HELPER),
                command,
                "--workspace",
                os.fspath(self.workspace),
                *arguments,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            expected_returncode,
            result.returncode,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return result

    def init_task(self, task_id: str = "task-example") -> Path:
        result = self.run_helper("init", "--task-id", task_id)
        self.assertEqual(f"task_id={task_id}\n", result.stdout)
        return self.workspace / "task-memory" / task_id

    def assert_cli_error(self, result: subprocess.CompletedProcess[str], text: str) -> None:
        self.assertIn(text, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual("", result.stdout)

    def test_lifecycle_preserves_output_keys_and_deletes_in_progress_report(self) -> None:
        task_dir = self.init_task()
        self.assertTrue((task_dir / "task_state.md").is_file())
        self.assertTrue((task_dir / "reports").is_dir())
        self.assertTrue((task_dir / "artifacts").is_dir())

        status = self.run_helper("status", "--task-id", "task-example")
        self.assertEqual("reports=none\n", status.stdout)

        created = self.run_helper(
            "create-report", "--task-id", "task-example", "--name", "Worker Result"
        )
        self.assertRegex(created.stdout, r"^report=\d{8}-001-worker-result\.md\n$")
        report_name = created.stdout.strip().split("=", 1)[1]
        report_path = task_dir / "reports" / report_name
        self.assertIn("Status: in-progress", report_path.read_text(encoding="utf-8"))

        second = self.run_helper(
            "create-report", "--task-id", "task-example", "--name", "Worker Result"
        )
        self.assertRegex(second.stdout, r"^report=\d{8}-002-worker-result\.md\n$")

        status = self.run_helper("status", "--task-id", "task-example")
        second_report_name = second.stdout.strip().split("=", 1)[1]
        self.assertEqual(f"reports={report_name},{second_report_name}\n", status.stdout)

        deleted = self.run_helper(
            "delete-report", "--task-id", "task-example", "--report", report_name
        )
        self.assertEqual(f"deleted={report_name}\n", deleted.stdout)
        self.assertFalse(report_path.exists())

    def test_init_allocates_numeric_suffix(self) -> None:
        self.init_task()
        result = self.run_helper("init", "--task-id", "task-example")
        self.assertEqual("task_id=task-example-001\n", result.stdout)

    def test_relative_workspace_is_rejected_without_traceback(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                os.fspath(HELPER),
                "init",
                "--workspace",
                "relative-workspace",
                "--task-id",
                "task-example",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(2, result.returncode)
        self.assert_cli_error(result, "--workspace must be an absolute path")

    def test_invalid_tokens_are_rejected_without_traceback(self) -> None:
        bad_task = self.run_helper(
            "init", "--task-id", "example", expected_returncode=2
        )
        self.assert_cli_error(bad_task, "--task-id must start with task-")

        self.init_task()
        bad_name = self.run_helper(
            "create-report",
            "--task-id",
            "task-example",
            "--name",
            "___",
            expected_returncode=2,
        )
        self.assert_cli_error(
            bad_name, "--name must contain at least one letter or digit"
        )

    def test_every_existing_task_command_requires_complete_directory_layout(self) -> None:
        task_dir = self.init_task()
        (task_dir / "artifacts").rmdir()

        for command, extra_arguments in (
            ("status", ()),
            ("create-report", ("--name", "worker")),
            ("delete-report", ("--report", "20260711-001-worker.md")),
        ):
            with self.subTest(command=command):
                result = self.run_helper(
                    command,
                    "--task-id",
                    "task-example",
                    *extra_arguments,
                    expected_returncode=2,
                )
                self.assert_cli_error(result, "missing artifacts directory")

    def test_status_rejects_missing_or_wrong_task_structure_entries(self) -> None:
        cases = (
            ("missing-state", "task_state.md", "unlink", "missing task_state.md"),
            (
                "directory-state",
                "task_state.md",
                "replace-with-directory",
                "task_state.md is not a regular file",
            ),
            ("missing-reports", "reports", "rmdir", "missing reports directory"),
            (
                "file-reports",
                "reports",
                "replace-with-file",
                "reports directory is not a directory",
            ),
            ("missing-artifacts", "artifacts", "rmdir", "missing artifacts directory"),
            (
                "file-artifacts",
                "artifacts",
                "replace-with-file",
                "artifacts directory is not a directory",
            ),
        )

        for suffix, entry_name, mutation, error_text in cases:
            with self.subTest(mutation=mutation):
                task_id = f"task-{suffix}"
                task_dir = self.init_task(task_id)
                entry = task_dir / entry_name
                if mutation == "unlink":
                    entry.unlink()
                elif mutation == "rmdir":
                    entry.rmdir()
                elif mutation == "replace-with-directory":
                    entry.unlink()
                    entry.mkdir()
                else:
                    entry.rmdir()
                    entry.write_text("not a directory\n", encoding="utf-8")

                result = self.run_helper(
                    "status", "--task-id", task_id, expected_returncode=2
                )
                self.assert_cli_error(result, error_text)

    def test_task_state_hard_link_is_rejected(self) -> None:
        task_dir = self.init_task()
        os.link(task_dir / "task_state.md", task_dir / "task_state-copy.md")

        result = self.run_helper(
            "status", "--task-id", "task-example", expected_returncode=2
        )
        self.assert_cli_error(result, "refusing hard-linked task_state.md")

    def test_managed_report_hard_link_is_rejected(self) -> None:
        task_dir = self.init_task()
        created = self.run_helper(
            "create-report", "--task-id", "task-example", "--name", "worker"
        )
        report_name = created.stdout.strip().split("=", 1)[1]
        report_path = task_dir / "reports" / report_name
        os.link(report_path, task_dir / "reports" / "report-copy.txt")

        result = self.run_helper(
            "status", "--task-id", "task-example", expected_returncode=2
        )
        self.assert_cli_error(result, "refusing hard-linked managed report")

    def test_task_state_symlink_is_rejected(self) -> None:
        task_dir = self.init_task()
        task_state = task_dir / "task_state.md"
        target = task_dir / "state-target.md"
        task_state.rename(target)
        try:
            task_state.symlink_to(target)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error}")

        result = self.run_helper(
            "status", "--task-id", "task-example", expected_returncode=2
        )
        self.assert_cli_error(result, "refusing task_state.md symlink or reparse point")

    def test_managed_report_symlink_is_rejected(self) -> None:
        task_dir = self.init_task()
        report = task_dir / "reports" / "20260711-001-worker.md"
        target = task_dir / "report-target.md"
        target.write_text("Status: in-progress\n", encoding="utf-8")
        try:
            report.symlink_to(target)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error}")

        result = self.run_helper(
            "status", "--task-id", "task-example", expected_returncode=2
        )
        self.assert_cli_error(result, "refusing report symlink or reparse point")

    def test_managed_directory_symlink_is_rejected(self) -> None:
        task_dir = self.init_task()
        reports_dir = task_dir / "reports"
        reports_dir.rmdir()
        target = task_dir / "reports-target"
        target.mkdir()
        try:
            reports_dir.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error}")

        result = self.run_helper(
            "status", "--task-id", "task-example", expected_returncode=2
        )
        self.assert_cli_error(
            result,
            "refusing reports directory that is a symlink, junction, or reparse point",
        )

    def test_delete_rejects_noncanonical_and_outside_report_paths(self) -> None:
        self.init_task()
        malformed = self.run_helper(
            "delete-report",
            "--task-id",
            "task-example",
            "--report",
            "notes.md",
            expected_returncode=2,
        )
        self.assert_cli_error(malformed, "invalid report filename")

        outside = self.workspace / "20260711-001-worker.md"
        outside.write_text("Status: in-progress\n", encoding="utf-8")
        escaped = self.run_helper(
            "delete-report",
            "--task-id",
            "task-example",
            "--report",
            os.fspath(outside),
            expected_returncode=2,
        )
        self.assert_cli_error(
            escaped, "refusing to delete a report outside the live reports directory"
        )
        self.assertTrue(outside.exists())


if __name__ == "__main__":
    unittest.main()
