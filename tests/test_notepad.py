"""NotepadWindow 与 show_notepad 工具的测试。"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

from voidmaker.agent.tools import build_pet_server  # noqa: E402
from voidmaker.ui.notepad_window import WINDOW_TITLE, NotepadWindow  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def test_show_content_formats(app):
    w = NotepadWindow({})
    assert w.isHidden()

    w.show_content("日志", "line1\n  line2", "text")
    assert not w.isHidden()
    assert "line1" in w._browser.toPlainText()
    assert WINDOW_TITLE in w._title.text() and "日志" in w._title.text()

    w.show_content("文档", "# 标题\n\n- 项目", "markdown")
    assert "标题" in w._browser.toPlainText()

    w.show_content("网页", "<b>粗</b>", "html")
    assert "粗" in w._browser.toPlainText()

    w.show_content("兜底", "x", "怪格式")  # 非法格式回落 markdown,不崩
    assert "x" in w._browser.toPlainText()


def test_hide_and_reshow(app):
    w = NotepadWindow({})
    w.show_content("a", "内容", "text")
    w.hide()
    assert w.isHidden()
    w.show_content("b", "再来", "text")
    assert not w.isHidden()


def test_tool_registered_only_with_callback():
    _s, allowed = build_pet_server()
    assert "mcp__pet__show_notepad" not in allowed  # 无回调不注册
    _s2, allowed2 = build_pet_server(show_notepad=lambda *a: None)
    assert "mcp__pet__show_notepad" in allowed2
