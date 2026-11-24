"""Inspect and complete optional dependencies for this Python interpreter."""

import json
import os
import subprocess
import sys
import sysconfig


_PACKAGES = {
    "zstandard": ("zstandard", "Verify thread headers in compressed rollout archives."),
    "tomli": ("tomli", "Read Codex configuration on Python 3.10."),
}
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_PROBE = """
import json
import sys

def available(name):
    try:
        if name == 'zstandard':
            import zstandard
            return hasattr(zstandard, 'ZstdDecompressor')
        import tomli
        return hasattr(tomli, 'load')
    except (ImportError, OSError, RuntimeError, ValueError):
        return False

print(json.dumps({name: available(name) for name in sys.argv[1:]}))
"""


def dependency_status() -> dict:
    names = list(_PACKAGES)
    if sys.version_info >= (3, 11):
        names.remove("tomli")
    result = {"python": sys.executable, "site_packages": sysconfig.get_path("purelib"), "items": []}
    try:
        probe = subprocess.run(
            [sys.executable, "-B", "-c", _PROBE, *names],
            capture_output=True, check=True, timeout=10, creationflags=_NO_WINDOW,
        )
        availability = json.loads(probe.stdout)
        result["items"] = [
            {"name": name, "purpose": _PACKAGES[name][1], "available": availability[name]}
            for name in names
        ]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        result["error"] = "Could not check dependencies with this Python interpreter."
    return result


def install_dependencies() -> dict:
    status = dependency_status()
    missing = [_PACKAGES[item["name"]][0] for item in status["items"] if not item["available"]]
    if not missing:
        return status
    error = None
    try:
        result = subprocess.run(
            [
                sys.executable, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
                "install", "--no-user", "--no-input", "--only-binary=:all:",
                "--no-deps", "--force-reinstall", *missing,
            ],
            capture_output=True, stdin=subprocess.DEVNULL, timeout=90,
            creationflags=_NO_WINDOW,
            env={**os.environ, "PIP_CONFIG_FILE": os.devnull},
        )
        if result.returncode != 0:
            output = result.stdout.lower() + result.stderr.lower()
            if b"no module named pip" in output:
                error = "This Python interpreter has no pip."
            elif b"externally-managed-environment" in output:
                error = "This Python environment is managed by the system package manager."
            elif any(text in output for text in (b"permission denied", b"access is denied", b"winerror 5")):
                error = "This Python installation does not allow writes to the displayed directory."
            elif b"no matching distribution" in output:
                error = "Pip could not find a compatible wheel for this Python interpreter."
            else:
                error = "Pip could not install the dependencies. Check the package connection and Python permissions."
    except subprocess.TimeoutExpired:
        error = "Dependency installation timed out. Refresh to check what was installed."
    except OSError:
        error = "Could not start pip with this Python interpreter."

    status = dependency_status()
    if error:
        status["error"] = error
    elif any(not item["available"] for item in status["items"]):
        status["error"] = "Some dependencies remain unavailable to this Python interpreter."
    return status
