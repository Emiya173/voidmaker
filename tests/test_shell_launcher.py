"""Quickshell 单例启动与快捷键切换。"""

from types import SimpleNamespace
from unittest.mock import Mock

from voidmaker.ui import shell_launcher


def test_existing_shell_uses_quickshell_ipc(monkeypatch):
    monkeypatch.setattr(shell_launcher.shutil, "which", lambda name: "/bin/quickshell")
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr(shell_launcher.subprocess, "run", run)
    execve = Mock()
    monkeypatch.setattr(shell_launcher.os, "execve", execve)

    assert shell_launcher.launch_shell() == 0
    command = run.call_args.args[0]
    assert command[-4:] == ["ipc", "call", "voidmaker", "toggle"]
    execve.assert_not_called()


def test_existing_classic_window_does_not_start_second_shell(monkeypatch):
    monkeypatch.setattr(shell_launcher.shutil, "which", lambda name: "/bin/quickshell")
    monkeypatch.setattr(shell_launcher.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=255))
    control = Mock(return_value=True)
    monkeypatch.setattr(shell_launcher, "send_ctl", control)
    execve = Mock()
    monkeypatch.setattr(shell_launcher.os, "execve", execve)

    assert shell_launcher.launch_shell() == 0
    control.assert_called_once_with("toggle")
    execve.assert_not_called()


def test_compose_opens_first_level_input(monkeypatch):
    call = Mock(return_value=True)
    monkeypatch.setattr(shell_launcher, "call_shell", call)

    assert shell_launcher.show_compose() == 0
    call.assert_called_once_with("compose")


def test_shell_action_uses_ipc_for_hide_and_capture(monkeypatch):
    call = Mock(return_value=True)
    monkeypatch.setattr(shell_launcher, "call_shell", call)

    assert shell_launcher.shell_action("hide") == 0
    assert shell_launcher.shell_action("capture") == 0
    assert [entry.args[0] for entry in call.call_args_list] == ["hide", "capture"]
