"""PermissionBubble 组件的离屏 Qt 测试:显示、按钮语义、信号。"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication  # noqa: E402

from voidmaker.ui.permission_bubble import PermissionBubble  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def _click(bubble, label):
    from PySide6.QtWidgets import QPushButton

    next(b for b in bubble.findChildren(QPushButton) if b.text() == label).click()


def test_ask_shows_and_three_choices(app):
    for label, expected in (("仅这次", "once"), ("一直允许", "always"), ("拒绝", "deny")):
        bubble = PermissionBubble({})
        results = []
        bubble.answered.connect(results.append)
        assert bubble.isHidden()
        bubble.ask("Bash", '{"command": "ls"}')
        assert not bubble.isHidden()
        _click(bubble, label)
        assert results == [expected]
        assert bubble.isHidden()  # 回答后收起
