"""字幕气泡:打字机效果 + 内容超高时内部滚动(窗口固定尺寸,不自我 resize)。

高度随内容在 MAX_BUBBLE_HEIGHT 内伸缩;超出则出现竖向滚动条,打字时自动
滚到底显示最新文本。长笔记/代码/长回复不再被固定气泡区裁掉。
"""

from __future__ import annotations

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QLabel, QScrollArea

TYPE_INTERVAL_MS = 28
HOLD_BASE_MS = 1200
HOLD_PER_CHAR_MS = 45
MAX_BUBBLE_HEIGHT = 180  # 略小于气泡区 BUBBLE_AREA_HEIGHT(190),留呼吸


class BubbleLabel(QScrollArea):
    """打字机气泡(可滚动)。start() 逐字渲染,渲染完按文本长度停留,然后发 finished。"""

    finished = Signal()

    def __init__(self, theme: dict, parent=None):
        super().__init__(parent)
        self._label = QLabel(self)
        self._label.setWordWrap(True)
        self._label.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self._label.setStyleSheet(
            f"""
            QLabel {{
                background-color: {theme.get("bubble_background_color", "#ffe8f1")};
                color: {theme.get("text_color", "#3d2b35")};
                border: 1px solid {theme.get("border_color", "#eeacc8")};
                border-radius: 14px;
                padding: 10px 14px;
                font-size: 14px;
            }}
            """
        )
        self.setWidget(self._label)
        self.setWidgetResizable(True)
        self.setFrameShape(QScrollArea.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        self.viewport().setStyleSheet("background: transparent;")
        self.hide()

        self._target = ""
        self._pos = 0
        self._timer = QTimer(self)
        self._timer.setInterval(TYPE_INTERVAL_MS)
        self._timer.timeout.connect(self._tick)

    def start(self, text: str) -> None:
        self._timer.stop()
        self._target = text
        self._pos = 0
        self._label.setText("")
        self.show()
        self._sync_height()
        if text:
            self._timer.start()
        else:
            self.finished.emit()

    def _tick(self) -> None:
        self._pos += 1
        self._label.setText(self._target[: self._pos])
        self._sync_height()
        if self._pos >= len(self._target):
            self._timer.stop()
            hold = HOLD_BASE_MS + HOLD_PER_CHAR_MS * len(self._target)
            QTimer.singleShot(hold, self.finished.emit)

    def flush(self) -> None:
        """立即显示完整文本(跳过打字机)。"""
        if self._timer.isActive():
            self._timer.stop()
            self._label.setText(self._target)
            self._sync_height()
            QTimer.singleShot(HOLD_BASE_MS, self.finished.emit)

    def _sync_height(self) -> None:
        """按内容定高(封顶 MAX_BUBBLE_HEIGHT),并滚到底显示最新文本。"""
        width = self.viewport().width()
        if width > 0 and self._label.hasHeightForWidth():
            needed = self._label.heightForWidth(width)
        else:
            needed = self._label.sizeHint().height()
        self.setFixedHeight(min(needed, MAX_BUBBLE_HEIGHT))
        bar = self.verticalScrollBar()
        bar.setValue(bar.maximum())
