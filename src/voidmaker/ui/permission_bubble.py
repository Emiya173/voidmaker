"""内嵌权限请示气泡:她在气泡区里问"能不能用某工具",配 允许/拒绝 按钮。

取代模态 QMessageBox——不弹独立窗口、不遮立绘,风格与字幕气泡一致,
非模态(agent 侧 await future,主线程不阻塞)。
"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget


class PermissionBubble(QWidget):
    answered = Signal(str)  # "once" | "always" | "deny"

    def __init__(self, theme: dict, parent=None):
        super().__init__(parent)
        text_color = theme.get("text_color", "#3d2b35")
        border = theme.get("border_color", "#eeacc8")
        bg = theme.get("bubble_background_color", "#ffe8f1")
        btn_bg = theme.get("input_background_color", "#ffffff")

        self._label = QLabel(self)
        self._label.setWordWrap(True)
        self._label.setStyleSheet(f"color: {text_color}; font-size: 14px; background: transparent;")

        # 三档:拒绝 / 仅这次 / 一直允许(后者跨会话持久,该工具不再问)
        deny_btn = QPushButton("拒绝", self)
        once_btn = QPushButton("仅这次", self)
        always_btn = QPushButton("一直允许", self)
        for btn in (deny_btn, once_btn, always_btn):
            btn.setFixedHeight(28)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
        filled = (
            f"QPushButton {{ background:{btn_bg}; color:{text_color}; border:1px solid {border};"
            f" border-radius:14px; padding:0 14px; font-size:13px; }}"
            f" QPushButton:hover {{ background:{border}; }}"
        )
        outlined = (
            f"QPushButton {{ background:transparent; color:{text_color}; border:1px solid {border};"
            f" border-radius:14px; padding:0 14px; font-size:13px; }}"
            f" QPushButton:hover {{ background:{btn_bg}; }}"
        )
        deny_btn.setStyleSheet(outlined)
        once_btn.setStyleSheet(filled)
        always_btn.setStyleSheet(filled)
        deny_btn.clicked.connect(lambda: self._answer("deny"))
        once_btn.clicked.connect(lambda: self._answer("once"))
        always_btn.clicked.connect(lambda: self._answer("always"))

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        btn_row.addStretch(1)
        btn_row.addWidget(deny_btn)
        btn_row.addWidget(once_btn)
        btn_row.addWidget(always_btn)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)
        layout.setSpacing(8)
        layout.addWidget(self._label)
        layout.addLayout(btn_row)

        self.setStyleSheet(
            f"PermissionBubble {{ background:{bg}; border:1px solid {border}; border-radius:14px; }}"
        )
        self.hide()

    def ask(self, tool_name: str, detail: str) -> None:
        text = f"想使用工具「{tool_name}」"
        if detail:
            text += f"\n{detail}"
        text += "\n允许吗?"
        self._label.setText(text)
        self.show()

    def _answer(self, choice: str) -> None:
        self.hide()
        self.answered.emit(choice)
