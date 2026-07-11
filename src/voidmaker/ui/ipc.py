"""桌宠单例控制:本地 Unix socket 收发快捷键命令(toggle 显隐 / quit 退出)。

用 stdlib socket + QSocketNotifier(QtCore),不依赖 QtNetwork——本机 devShell
里 QtNetwork 缺 libgssapi_krb5。send_ctl 是纯 socket,--quit 无需起 Qt 事件循环。
"""

from __future__ import annotations

import os
import socket
from collections.abc import Callable

from PySide6.QtCore import QObject, QSocketNotifier


def _sock_path() -> str:
    base = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    return os.path.join(base, "voidmaker-ctl.sock")


def send_ctl(cmd: str, timeout: float = 0.3) -> bool:
    """向运行中的桌宠实例发命令。连不上(没实例)返回 False。"""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(_sock_path())
        sock.sendall((cmd + "\n").encode())
        return True
    except OSError:
        return False
    finally:
        sock.close()


class ControlServer(QObject):
    """监听控制 socket,收到命令时回调 on_command(cmd)(在 Qt 主线程)。"""

    def __init__(self, on_command: Callable[[str], None], parent: QObject | None = None):
        super().__init__(parent)
        self._on_command = on_command
        path = _sock_path()
        try:
            os.unlink(path)  # 清理上次异常退出残留的 socket 文件
        except FileNotFoundError:
            pass
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(path)
        self._sock.listen(4)
        self._sock.setblocking(False)
        self._notifier = QSocketNotifier(
            self._sock.fileno(), QSocketNotifier.Type.Read, self
        )
        self._notifier.activated.connect(self._accept)

    def _accept(self) -> None:
        try:
            conn, _ = self._sock.accept()
        except OSError:
            return
        conn.settimeout(0.3)
        try:
            data = conn.recv(256)
        except OSError:
            data = b""
        finally:
            conn.close()
        cmd = data.decode(errors="ignore").strip()
        if cmd:
            self._on_command(cmd)

    def close(self) -> None:
        self._notifier.setEnabled(False)
        self._sock.close()
        try:
            os.unlink(_sock_path())
        except OSError:
            pass
