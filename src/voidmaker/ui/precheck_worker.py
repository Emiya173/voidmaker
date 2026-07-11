"""主动感知预判线程:每个周期起一个短命 QThread 跑 haiku 二分类。

预判失败(截图失败、CLI 错误等)按 SILENT 处理——宁可这轮沉默,
也不回退到直接烧主模型。
"""

from __future__ import annotations

import asyncio

from PySide6.QtCore import QThread, Signal

from ..agent.precheck import screen_worth_speaking


class PrecheckWorker(QThread):
    decided = Signal(bool)  # True = 值得开口

    def __init__(self, model: str, parent=None):
        super().__init__(parent)
        self._model = model

    def run(self) -> None:
        try:
            speak = asyncio.run(screen_worth_speaking(self._model))
        except Exception as exc:
            print(f"[voidmaker] 主动感知预判失败(本轮沉默): {exc}", flush=True)
            speak = False
        self.decided.emit(speak)
