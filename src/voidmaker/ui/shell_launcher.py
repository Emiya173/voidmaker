"""启动 Quickshell 侧栏；再次启动时切换第二级。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from .ipc import send_ctl


def call_shell(method: str) -> bool:
    quickshell = shutil.which("quickshell")
    if quickshell is None:
        return False

    shell = Path(__file__).with_name("quickshell") / "shell.qml"
    try:
        existing = subprocess.run(
            [quickshell, "--path", str(shell), "ipc", "call", "voidmaker", method],
            capture_output=True,
            check=False,
            timeout=2,
        )
        if existing.returncode == 0:
            return True
    except subprocess.TimeoutExpired:
        pass
    return False


def shell_action(method: str) -> int:
    if call_shell(method):
        return 0
    print("[voidmaker] 没有运行中的 Quickshell 界面；请先启动 python -m voidmaker", file=sys.stderr)
    return 1


def show_compose() -> int:
    return shell_action("compose")


def launch_shell() -> int:
    if call_shell("toggle"):
        return 0
    if send_ctl("toggle"):
        return 0

    quickshell = shutil.which("quickshell")
    if quickshell is None:
        print("[voidmaker] 未找到 quickshell；请运行 nix develop，或使用 --classic", file=sys.stderr)
        return 1

    shell = Path(__file__).with_name("quickshell") / "shell.qml"
    env = os.environ.copy()
    env["VOIDMAKER_PYTHON"] = sys.executable
    os.execve(quickshell, [quickshell, "--no-duplicate", "--path", str(shell)], env)
    return 1  # pragma: no cover — execve 成功不会返回
