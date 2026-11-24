import json
import os
import subprocess
from pathlib import Path


PLUGIN = Path(__file__).resolve().parents[1]
HOOK_EXE = Path(
    os.environ.get("THREAD_MEMORY_TEST_HOOK_EXE", PLUGIN / "bin" / "Thread-Memory-Hook.exe")
).resolve()
CLI_EXE = Path(
    os.environ.get("THREAD_MEMORY_TEST_CLI_EXE", PLUGIN / "bin" / "Thread-Memory.exe")
).resolve()
REFERENCE_CLI = Path(__file__).with_name("reference_rollout_cli.py").resolve()


def run_native_hook(request, *, env, check=False):
    payload = request if isinstance(request, bytes) else json.dumps(
        request, ensure_ascii=False
    ).encode("utf-8")
    return subprocess.run(
        [str(HOOK_EXE)], input=payload, capture_output=True, check=check, env=env
    )
