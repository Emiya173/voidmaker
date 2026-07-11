"""框选截图线程:slurp 交互选区 + grim 截取,读出字节后即删临时文件。

slurp 会阻塞到用户完成/取消选择,必须放后台线程,否则冻住 Qt 主循环。
"""

from __future__ import annotations

import asyncio

from PySide6.QtCore import QThread, Signal

from ..perception.screenshot import capture_region


class SnipWorker(QThread):
    captured = Signal(bytes)  # PNG 字节
    failed = Signal(str)  # 含用户取消(slurp 非零退出)

    def run(self) -> None:
        try:
            path = asyncio.run(capture_region())
        except Exception as exc:
            self.failed.emit(str(exc))
            return
        try:
            data = path.read_bytes()
        finally:
            path.unlink(missing_ok=True)
        self.captured.emit(data)
