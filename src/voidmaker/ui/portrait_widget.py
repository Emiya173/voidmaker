"""立绘绘制部件(视口模型 + 取景目标缓动)。

pack 存完整立绘,窗口显示其一个子区域(取景框)。取景不是离散运镜,而是
"目标 + 缓动趋近":每张表情/语气设一个静止取景目标,_reveal 平滑趋近它,
切换自然不突兀。

取景语义:
- 姿势自适应(B):伸手/拍胸/撩发/侧身等舒展姿势 → 镜头拉开露出手势;
- 情绪运镜(C):害羞/难过等亲近情绪 → 轻微前倾拉近;中性 → 半身。
瞬时动效(A):
- 说话:轻微前倾(zoom-in)强调,不再拉远;
- 入场:柔和淡入 + 从略拉开落定到半身;
- 换表情:缓动叠化 + 极轻缩放呼吸,遮住不同姿势叠化的重影。
渲染始终从高清源降采样,HiDPI 清晰;60fps。
"""

from __future__ import annotations

import math
import os
from pathlib import Path

from PySide6.QtCore import QRectF, Qt, QTimer
from PySide6.QtGui import QColor, QPainter, QPaintEvent, QPixmap
from PySide6.QtWidgets import QWidget

from ..character.model import CharacterCard

PLACEHOLDER_SIZE = (280, 380)
PORTRAIT_HEIGHT = 480
# 默认取景矩形(完整立绘的归一化子区域):差 nx1-nx0=框宽,和 nx0+nx1 偏离 1=左右微调;
# ny0/ny1=上/下边。reveal>0 以人物为中心等比拉远(露下半身),<0 拉近(前倾)。
VIEW = (0.23, 0.02, 0.77, 0.47)  # (nx0, ny0, nx1, ny1)

FRAME_MS = 16  # ~60fps
FADE_MS = 240.0  # 换表情叠化时长
REVEAL_EASE = 0.16  # 每帧向取景目标趋近的比例(指数缓动,越大越快)
ENTRANCE_SETTLE = 0.24  # 入场:初始比目标多拉开这么多,再缓动落定
FADE_POP = 0.03  # 叠化期极轻的缩放呼吸(遮重影)
SPEAK_MS = 460.0  # 说话前倾时长
SPEAK_LEAN = 0.06  # 说话前倾(zoom-in)幅度

# 取景目标(B 姿势 + C 情绪),按表情/语气关键词匹配
EXPANSIVE_KEYS = ("伸手", "拍胸", "撩发", "侧身", "命令", "抚摸", "自信", "放光")
INTIMATE_KEYS = ("害羞", "难过", "沮丧", "脸红", "哭", "委屈")
EXPANSIVE_REVEAL = 0.5  # 舒展姿势:拉开露出手势/姿态
INTIMATE_REVEAL = -0.1  # 亲近情绪:轻微前倾拉近


def _ease(t: float) -> float:
    """smoothstep 缓入缓出:两端速度为 0,消除起止突变。"""
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    return t * t * (3.0 - 2.0 * t)


def _framing_target(expression: str | None, tone: str | None) -> float:
    text = f"{expression or ''}{tone or ''}"
    if any(k in text for k in EXPANSIVE_KEYS):
        return EXPANSIVE_REVEAL
    if any(k in text for k in INTIMATE_KEYS):
        return INTIMATE_REVEAL
    return 0.0


def _content_center_x(path: Path | None) -> float:
    """立绘非透明内容的水平中心(0..1)。取不到时回落 0.5。"""
    if path is None or not path.is_file():
        return 0.5
    try:
        from PIL import Image

        with Image.open(path) as im:
            bbox = im.convert("RGBA").getbbox()
        if bbox:
            return (bbox[0] + bbox[2]) / 2.0 / im.width
    except Exception:
        pass
    return 0.5


class PortraitWidget(QWidget):
    def __init__(self, card: CharacterCard | None = None, parent: QWidget | None = None):
        super().__init__(parent)
        self._card = card
        self._pixmap: QPixmap | None = None
        self._prev: QPixmap | None = None  # 叠化中的上一张
        self._path: Path | None = None
        self._fade = 1.0  # 0→1 叠化进度(1=完成)
        self._reveal = 0.0  # 当前取景(>0 拉远露下半身,<0 前倾拉近)
        self._target = 0.0  # 静止取景目标(表情/语气决定)
        self._speak = 0.0  # 说话前倾剩余(ms)
        self._char_cx = 0.5  # 角色水平中心
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)

        self._anim = QTimer(self)
        self._anim.setInterval(FRAME_MS)
        self._anim.timeout.connect(self._tick)
        self.set_portrait(card.portrait_for(None) if card else None)

    # --- 立绘切换 ---

    def set_portrait(self, path: Path | None) -> None:
        """切换立绘(相同则不重切)。目标取景由 set_portrait_for 预先设好。"""
        if path == self._path and (self._pixmap is not None or path is None):
            return
        first = self._pixmap is None and self._path is None
        self._path = path
        pixmap: QPixmap | None = None
        if path is not None and path.is_file():
            loaded = QPixmap(str(path))
            if not loaded.isNull():
                pixmap = loaded
        self._prev = self._pixmap
        self._pixmap = pixmap
        self._fade = 0.0  # 淡入/叠化(首张从透明淡入,无重影)
        if first and pixmap is not None:
            self._char_cx = _content_center_x(path)
            self._reveal = self._target + ENTRANCE_SETTLE  # 入场:从略拉开落定
        self._resize()
        self.update()
        self._ensure_animating()

    def set_portrait_for(self, portrait: str | None, tone: str | None = None) -> None:
        if self._card is not None:
            self._target = _framing_target(portrait, tone)  # B+C:按姿势/情绪设取景目标
            self.set_portrait(self._card.portrait_for(portrait, tone))

    def pulse(self) -> None:
        """一段回复开始:轻微前倾强调(不改变静止取景目标)。"""
        self._speak = SPEAK_MS
        self._ensure_animating()

    def _resize(self) -> None:
        if self._pixmap is not None and self._pixmap.height() > 0:
            nx0, ny0, nx1, ny1 = VIEW
            aspect = ((nx1 - nx0) * self._pixmap.width()) / ((ny1 - ny0) * self._pixmap.height())
            self.setFixedSize(round(PORTRAIT_HEIGHT * aspect), PORTRAIT_HEIGHT)
        else:
            self.setFixedSize(*PLACEHOLDER_SIZE)

    # --- 动效帧 ---

    def _ensure_animating(self) -> None:
        if not self._anim.isActive() and (
            self._fade < 1.0 or self._speak > 0.0 or abs(self._reveal - self._target) > 0.003
        ):
            self._anim.start()

    def _tick(self) -> None:
        if self._fade < 1.0:
            self._fade = min(1.0, self._fade + FRAME_MS / FADE_MS)
        if self._speak > 0.0:
            self._speak = max(0.0, self._speak - FRAME_MS)
        self._reveal += (self._target - self._reveal) * REVEAL_EASE  # 缓动趋近目标
        self.update()
        if self._fade >= 1.0 and self._speak <= 0.0 and abs(self._reveal - self._target) <= 0.003:
            self._reveal = self._target  # 落定,idle 停帧零重绘
            self._anim.stop()

    def _draw_reveal(self) -> float:
        """当前绘制用的取景量 = 缓动 reveal + 叠化呼吸 − 说话前倾。"""
        r = self._reveal
        if self._fade < 1.0:
            r += FADE_POP * math.sin(math.pi * _ease(self._fade))
        if self._speak > 0.0:
            q = 1.0 - self._speak / SPEAK_MS
            r -= SPEAK_LEAN * (1.0 - math.cos(2.0 * math.pi * q)) / 2.0  # 平滑前倾再回位
        return r

    # --- 绘制 ---

    def paintEvent(self, event: QPaintEvent) -> None:
        ui_test = os.environ.get("VOIDMAKER_UI_TEST", "")
        if ui_test == "blank":
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        if ui_test == "circle":
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(255, 0, 0, 255))
            painter.drawEllipse(self.rect().center(), 60, 60)
            return

        if self._pixmap is not None:
            target = QRectF(self.rect())
            src = self._source_rect(self._pixmap)
            fe = _ease(self._fade)
            if self._prev is not None and self._fade < 1.0:
                painter.setOpacity(1.0 - fe)
                painter.drawPixmap(target, self._prev, self._source_rect(self._prev))
            painter.setOpacity(fe)
            painter.drawPixmap(target, self._pixmap, src)
            painter.setOpacity(1.0)
            return

        self._paint_placeholder(painter)

    def _source_rect(self, pm: QPixmap) -> QRectF:
        nx0, ny0, nx1, ny1 = VIEW
        by0 = ny0 * pm.height()
        bw, bh = (nx1 - nx0) * pm.width(), (ny1 - ny0) * pm.height()
        aspect = bw / bh
        r = self._draw_reveal()
        h = bh + (pm.height() - by0 - bh) * r
        h = max(bh * 0.55, min(h, pm.height() - by0))  # 防过度拉近/越界
        w = h * aspect
        cx = (self._char_cx + (nx0 + nx1) / 2.0 - 0.5) * pm.width()
        return QRectF(cx - w / 2.0, by0, w, h)

    def _paint_placeholder(self, painter: QPainter) -> None:
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(30, 30, 46, 200))
        painter.drawRoundedRect(self.rect(), 24, 24)
        painter.setBrush(QColor(137, 180, 250, 230))
        painter.drawEllipse(self.rect().center().x() - 60, 72, 120, 120)
        painter.setPen(QColor(230, 230, 240))
        font = painter.font()
        font.setPointSize(14)
        painter.setFont(font)
        painter.drawText(
            self.rect().adjusted(0, 240, 0, 0),
            Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop,
            "VoidMaker\n(未加载角色包)",
        )
