"""PortraitWidget 视口 + 取景目标缓动的离屏 Qt 测试。"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

pytest.importorskip("PySide6")
from PySide6.QtGui import QColor, QPixmap  # noqa: E402
from PySide6.QtWidgets import QApplication, QWidget  # noqa: E402

from voidmaker.ui.portrait_widget import (  # noqa: E402
    EXPANSIVE_REVEAL,
    INTIMATE_REVEAL,
    PORTRAIT_HEIGHT,
    VIEW,
    PortraitWidget,
    _framing_target,
)


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


def _make_png(tmp_path, name, color, w=200, h=300):
    pix = QPixmap(w, h)
    pix.fill(QColor(color))
    path = tmp_path / name
    assert pix.save(str(path), "PNG")
    return path


def _host(w):
    host = QWidget()
    host.resize(400, 560)
    w.setParent(host)
    host.show()
    return host


def test_window_size_from_view_rect(app, tmp_path):
    w = PortraitWidget()
    _keep = _host(w)
    w.set_portrait(_make_png(tmp_path, "a.png", "red", w=200, h=300))
    assert w.height() == PORTRAIT_HEIGHT
    nx0, ny0, nx1, ny1 = VIEW
    aspect = ((nx1 - nx0) * 200) / ((ny1 - ny0) * 300)
    assert w.width() == round(PORTRAIT_HEIGHT * aspect)


def test_framing_target_by_keyword():
    assert _framing_target("伸手命令", None) == EXPANSIVE_REVEAL
    assert _framing_target("自信撩发", "中性") == EXPANSIVE_REVEAL
    assert _framing_target("害羞脸红", None) == INTIMATE_REVEAL
    assert _framing_target("站立待机", "中性") == 0.0


def test_source_rect_reveal_signs(app, tmp_path):
    w = PortraitWidget()
    _keep = _host(w)
    w.set_portrait(_make_png(tmp_path, "a.png", "red", w=200, h=300))
    w._fade = 1.0
    w._speak = 0.0
    ny0, ny1 = VIEW[1], VIEW[3]
    w._reveal = 0.0
    assert w._source_rect(w._pixmap).height() == pytest.approx((ny1 - ny0) * 300)
    w._reveal = 0.5  # 拉远 → 取景更高
    assert w._source_rect(w._pixmap).height() > (ny1 - ny0) * 300
    w._reveal = -0.1  # 前倾 → 取景更矮(zoom in)
    assert w._source_rect(w._pixmap).height() < (ny1 - ny0) * 300


def test_reveal_eases_to_target(app, tmp_path):
    w = PortraitWidget()
    _keep = _host(w)
    w.set_portrait(_make_png(tmp_path, "a.png", "red"))
    w._target = EXPANSIVE_REVEAL  # 切到舒展姿势
    for _ in range(80):
        w._tick()
    assert w._reveal == pytest.approx(EXPANSIVE_REVEAL, abs=0.01)  # 平滑趋近并落定
    assert not w._anim.isActive()


def test_pulse_leans_in_then_returns(app, tmp_path):
    w = PortraitWidget()
    _keep = _host(w)
    w.set_portrait(_make_png(tmp_path, "a.png", "red"))
    w._target = 0.0
    for _ in range(80):
        w._tick()  # 先落定
    base = w._draw_reveal()
    w.pulse()
    w._tick()
    assert w._draw_reveal() < base  # 说话前倾:reveal 变小(zoom in)
    for _ in range(60):
        w._tick()
    assert w._speak == 0.0
    assert w._draw_reveal() == pytest.approx(base, abs=0.005)  # 回位
