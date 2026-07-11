"""独立记事窗口:把整理好的长内容/结构化信息从聊天气泡里解放出来。

用途:终端输出/日志、markdown 文档、代码、表格、HTML 富文本——不塞进短气泡、
不走 TTS,单独一个可滚动窗口展示。由 show_notepad 工具触发(agent 线程),经
PetWindow 信号在主线程建/更新(单例复用,保留窗口位置)。

Wayland 约束:不自我定位。固定 windowTitle 前缀,让 niri window-rule 单独匹配
定位(见 README);内容里的链接点击走系统浏览器(setOpenExternalLinks)。
"""

from __future__ import annotations

from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

WINDOW_TITLE = "VoidMaker 记事本"  # 固定前缀,供 niri window-rule 按 title 匹配


class NotepadWindow(QWidget):
    def __init__(self, theme: dict | None = None):
        super().__init__(None)  # parent=None:独立顶层窗口
        theme = theme or {}
        fg = theme.get("text_color", "#3d2b35")
        border = theme.get("border_color", "#eeacc8")
        content_bg = theme.get("input_background_color", "#ffffff")
        bar_bg = theme.get("bubble_background_color", "#ffe8f1")

        self.setWindowTitle(WINDOW_TITLE)
        self.resize(560, 660)

        self._title = QLabel(WINDOW_TITLE, self)
        self._title.setStyleSheet(f"color:{fg}; font-size:14px; font-weight:bold; background:transparent;")
        copy_btn = QPushButton("复制", self)
        close_btn = QPushButton("✕", self)
        for b in (copy_btn, close_btn):
            b.setFixedHeight(26)
            b.setStyleSheet(
                f"QPushButton {{ background:{content_bg}; color:{fg}; border:1px solid {border};"
                f" border-radius:13px; padding:0 12px; font-size:12px; }}"
                f" QPushButton:hover {{ background:{border}; }}"
            )
        copy_btn.clicked.connect(self._copy_all)
        close_btn.clicked.connect(self.hide)

        bar = QHBoxLayout()
        bar.setContentsMargins(12, 8, 8, 8)
        bar.setSpacing(8)
        bar.addWidget(self._title, stretch=1)
        bar.addWidget(copy_btn)
        bar.addWidget(close_btn)
        bar_widget = QWidget(self)
        bar_widget.setLayout(bar)
        bar_widget.setStyleSheet(f"background:{bar_bg};")

        self._browser = QTextBrowser(self)
        self._browser.setOpenExternalLinks(True)  # 链接点击走系统浏览器
        self._browser.setStyleSheet(
            f"QTextBrowser {{ background:{content_bg}; color:{fg}; border:none; padding:10px; }}"
        )

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(bar_widget)
        layout.addWidget(self._browser, stretch=1)

    def show_content(self, title: str, content: str, fmt: str) -> None:
        """按格式渲染内容并弹出窗口。fmt: text|markdown|html。"""
        self._title.setText(f"{WINDOW_TITLE} · {title}" if title else WINDOW_TITLE)
        fmt = (fmt or "markdown").lower()
        if fmt == "text":
            mono = QFont("monospace")
            mono.setStyleHint(QFont.StyleHint.Monospace)
            self._browser.setFont(mono)
            self._browser.setPlainText(content)
        elif fmt == "html":
            self._browser.setFont(QFont())
            self._browser.setHtml(content)
        else:  # markdown(默认)
            self._browser.setFont(QFont())
            self._browser.setMarkdown(content)
        self._browser.moveCursor(self._browser.textCursor().MoveOperation.Start)
        self.show()
        self.raise_()
        self.activateWindow()

    def _copy_all(self) -> None:
        from PySide6.QtWidgets import QApplication

        QApplication.clipboard().setText(self._browser.toPlainText())
