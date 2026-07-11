"""BubbleLabel 的离屏 Qt 测试:长内容封顶高度、短内容不封顶。"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtWidgets import QApplication, QWidget  # noqa: E402

from voidmaker.ui.bubble import MAX_BUBBLE_HEIGHT, BubbleLabel  # noqa: E402


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def _shown(bubble):
    # 离屏下需要一个可见容器 + 固定宽度,heightForWidth 才有意义
    host = QWidget()
    host.resize(360, 220)
    bubble.setParent(host)
    bubble.setFixedWidth(340)
    host.show()
    return host


def test_long_text_caps_height(app):
    bubble = BubbleLabel({})
    host = _shown(bubble)  # 持有引用,防 host 被 GC 连带销毁 bubble
    bubble.start("很长的内容。" * 200)
    bubble.flush()  # 直接铺满全文,触发定高
    app.processEvents()
    assert bubble.height() <= MAX_BUBBLE_HEIGHT
    assert host is not None


def test_short_text_below_cap(app):
    bubble = BubbleLabel({})
    host = _shown(bubble)
    bubble.start("嗨")
    bubble.flush()
    app.processEvents()
    assert bubble.height() <= MAX_BUBBLE_HEIGHT
    assert not bubble.isHidden()
    assert host is not None
