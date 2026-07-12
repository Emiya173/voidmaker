"""桌宠主窗口:单一顶层窗口,垂直组装 气泡区 + 立绘 + 输入条。

Wayland 下独立顶层窗口之间无法相对定位,因此不采用 sakura 的多窗口方案。
顶边尺寸固定(气泡区预留高度)——niri 锚定顶左,顶边伸缩会推动立绘
(mask 抠输入区域 niri 实测不穿透,已放弃);输入条在底边,可随焦点真伸缩。
"""

from __future__ import annotations

import json
import os
import time
from collections import deque

from PySide6.QtCore import QEvent, Qt, QTimer
from PySide6.QtGui import QAction, QMouseEvent
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLineEdit,
    QMenu,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..agent.reply import ReplySegment
from ..backchannel import BackchannelResolver, classify, load_manifest
from ..character.model import CharacterCard
from ..config import AppConfig
from ..perception.proactive import PROACTIVE_PROMPT
from ..storage.history import ChatHistory
from ..storage.memory import CharacterMemory
from ..storage.permissions import PermissionStore
from .agent_worker import AgentWorker
from .bubble import BubbleLabel
from .curator_worker import CuratorWorker
from .notepad_window import NotepadWindow
from .permission_bubble import PermissionBubble
from .portrait_widget import PortraitWidget
from .precheck_worker import PrecheckWorker
from ..voice.stt import Transcriber
from .snip_worker import SnipWorker
from .stt_worker import SttWorker
from .voice_chat_worker import VoiceChatWorker
from .voice_worker import VoiceWorker

BUBBLE_AREA_HEIGHT = 190
# 用户发言后等这么久还没有正式回复,才显示接话 filler(回复先到则取消)
BACKCHANNEL_DELAY_MS = 650


class PetWindow(QWidget):
    def __init__(self, card: CharacterCard | None, cfg: AppConfig):
        super().__init__()
        self._card = card
        self._segments: deque[tuple[int, ReplySegment]] = deque()
        self._showing = False
        char_id = card.id if card else "default"
        self._history = ChatHistory(char_id)
        self._memory = CharacterMemory(char_id)
        self._permissions = PermissionStore()  # 跨会话:auto 开关 + 一直允许名单
        # 字幕-语音同步状态机(见 _try_start_segment)
        self._seq_counter = 0
        self._audio_state: dict[int, bool] = {}  # seq → 是否有可播放音频;缺键=合成中
        self._waiting_seq: int | None = None
        self._bubble_done = True
        self._audio_playing = False

        self.setWindowFlags(Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setWindowTitle("VoidMaker")

        theme = card.theme if card else {}
        self._bubble = BubbleLabel(theme, self)
        self._bubble.finished.connect(self._on_bubble_finished)

        # 气泡开关(false = 纯语音/立绘);整轮播完后气泡停留一段时间再收起
        # (0 = 常显),新内容到来即取消
        self._bubble_enabled = cfg.ui.bubble_enabled
        self._bubble_hide_ms = int(max(cfg.ui.bubble_hide_seconds, 0) * 1000)
        self._bubble_hide_timer = QTimer(self)
        self._bubble_hide_timer.setSingleShot(True)
        self._bubble_hide_timer.timeout.connect(self._bubble.hide)

        self._portrait = PortraitWidget(card, self)

        self._input = QLineEdit(self)
        self._input.setPlaceholderText("和她说点什么…… (Enter 发送)")
        self._input.setFixedHeight(34)
        self._input.setStyleSheet(
            f"""
            QLineEdit {{
                background-color: {theme.get("input_background_color", "#ffffff")};
                color: {theme.get("text_color", "#3d2b35")};
                border: 1px solid {theme.get("border_color", "#eeacc8")};
                border-radius: 17px;
                padding: 0 14px;
                font-size: 13px;
            }}
            """
        )
        self._input.returnPressed.connect(self._on_send)

        # ✂ 框选截图:选一块屏幕连同输入文字一起发给她
        self._snip: SnipWorker | None = None
        button_style = f"""
            QPushButton {{
                background-color: {theme.get("input_background_color", "#ffffff")};
                border: 1px solid {theme.get("border_color", "#eeacc8")};
                border-radius: 17px;
                font-size: 15px;
            }}
            QPushButton:disabled {{ color: #bbbbbb; }}
            """
        self._snip_btn = QPushButton("✂", self)
        self._snip_btn.setFixedSize(34, 34)
        self._snip_btn.setToolTip("框选一块屏幕给她看(可先在输入条写想问的话)")
        self._snip_btn.setStyleSheet(button_style)
        self._snip_btn.clicked.connect(self._on_snip_clicked)

        # 🎤 语音输入(faster-whisper,懒加载);Transcriber 与连续对话共享
        self._stt: SttWorker | None = None
        self._mic_btn: QPushButton | None = None
        self._transcriber: Transcriber | None = None
        self._voice_chat: VoiceChatWorker | None = None
        self._voice_chat_on = False
        if cfg.stt.enabled:
            self._transcriber = Transcriber(cfg.stt)
            self._stt = SttWorker(cfg.stt, self._transcriber, self)
            self._stt.transcribed.connect(self._on_transcribed)
            self._stt.failed.connect(lambda msg: print(f"[voidmaker] STT: {msg}", flush=True))
            self._stt.start()
            self._mic_btn = QPushButton("🎤", self)
            self._mic_btn.setFixedSize(34, 34)
            self._mic_btn.setToolTip("点击开始/结束语音输入")
            self._mic_btn.setStyleSheet(
                f"""
                QPushButton {{
                    background-color: {theme.get("input_background_color", "#ffffff")};
                    border: 1px solid {theme.get("border_color", "#eeacc8")};
                    border-radius: 17px;
                    font-size: 15px;
                }}
                QPushButton:checked {{ background-color: #ff5c5c; }}
                """
            )
            self._mic_btn.setCheckable(True)
            self._mic_btn.clicked.connect(self._on_mic_clicked)

        # 权限请示气泡(内嵌气泡区,与字幕互斥显示,替代模态弹窗)
        self._perm_bubble = PermissionBubble(theme, self)
        self._perm_bubble.answered.connect(self._on_permission_answered)
        self._perm_queue: deque = deque()
        self._perm_current = None

        # 布局:气泡区固定高度(底部对齐),立绘,输入条
        self._bubble_area = QWidget(self)
        self._bubble_area.setFixedHeight(BUBBLE_AREA_HEIGHT)
        bubble_layout = QVBoxLayout(self._bubble_area)
        bubble_layout.setContentsMargins(0, 0, 0, 6)
        bubble_layout.addStretch(1)
        bubble_layout.addWidget(self._bubble)
        bubble_layout.addWidget(self._perm_bubble)

        self._input_bar = QWidget(self)
        input_row = QHBoxLayout(self._input_bar)
        input_row.setContentsMargins(0, 0, 0, 0)
        input_row.setSpacing(6)
        input_row.addWidget(self._input, stretch=1)
        input_row.addWidget(self._snip_btn)
        if self._mic_btn is not None:
            input_row.addWidget(self._mic_btn)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)
        layout.addWidget(self._bubble_area)
        layout.addWidget(self._portrait, alignment=Qt.AlignmentFlag.AlignHCenter)
        layout.addWidget(self._input_bar)
        self.setFixedSize(self.sizeHint())

        # 输入条仅窗口聚焦时显示(见 changeEvent);隐藏时窗口整体收缩,
        # 不留透明占位(输入条在底边,顶左锚定下立绘位置不受影响)
        self._input_focus_only = cfg.ui.input_focus_only
        if self._input_focus_only:
            self._set_input_bar_visible(False)
        if not self._bubble_enabled:
            # 关字幕:窗口不含气泡区,立绘上方无窗口、天然穿透;
            # 权限请示时临时展开(见 _show_next_permission)
            self._set_bubble_area_visible(False)

        homelab_url = cfg.homelab.hub_url if cfg.homelab.enabled else None
        self._worker = AgentWorker(
            card, cfg.agent, self._memory, self._permissions, homelab_url, self
        )
        self._worker.segment_ready.connect(self._on_segment)
        self._worker.turn_done.connect(self._on_turn_done)
        self._worker.failed.connect(self._on_error)
        self._worker.permission_request.connect(self._on_permission_request)
        self._worker.notepad_request.connect(self._on_notepad_request)
        self._worker.usage_ready.connect(self._on_usage)
        self._worker.start()
        self._turn_segs: list[dict] = []  # 当前轮攒的分段
        self._turn_usage: dict | None = None
        self._notepad: NotepadWindow | None = None  # 懒创建

        self._voice: VoiceWorker | None = None
        if cfg.tts.enabled and card is not None and card.voice is not None:
            self._voice = VoiceWorker(card, cfg.tts, self)
            self._voice.failed.connect(lambda msg: print(f"[voidmaker] {msg}", flush=True))
            self._voice.audio_ready.connect(self._on_audio_ready)
            self._voice.playback_done.connect(self._on_playback_done)
            self._voice.start()
            mode = "段内流式" if cfg.tts.streaming else "整段预合成"
            print(f"[voidmaker] TTS 已启用({mode}流水线)", flush=True)

        # 开场白(角色包 initial_message,不经 LLM)
        if card is not None:
            self._enqueue(ReplySegment(ja=card.initial_message, zh=card.initial_message))

        # 记忆整理子 agent:后台消化上次会话的历史,下次启动生效
        self._curator = CuratorWorker(char_id, self)
        self._curator.start()

        # backchannel 快速接话:等待期临时段,不进历史/LLM 上下文/语音队列
        self._bc_resolver = BackchannelResolver(
            load_manifest(card.backchannel_manifest if card else None)
        )
        self._bc_text = ""
        self._bc_timer = QTimer(self)
        self._bc_timer.setSingleShot(True)
        self._bc_timer.setInterval(BACKCHANNEL_DELAY_MS)
        self._bc_timer.timeout.connect(self._show_backchannel)

        # 主动屏幕感知(默认关闭;开启后周期让 agent 截屏自判是否开口)
        self._proactive_round = False
        self._last_proactive_spoke = 0.0
        self._cooldown_s = cfg.screen_awareness.cooldown_minutes * 60
        self._precheck_model = cfg.screen_awareness.precheck_model
        self._precheck: PrecheckWorker | None = None
        if cfg.screen_awareness.enabled:
            self._proactive_timer = QTimer(self)
            self._proactive_timer.setInterval(int(cfg.screen_awareness.interval_minutes * 60_000))
            self._proactive_timer.timeout.connect(self._proactive_tick)
            self._proactive_timer.start()
            print(
                f"[voidmaker] 主动感知已开启(每 {cfg.screen_awareness.interval_minutes:g} 分钟,"
                f"冷却 {cfg.screen_awareness.cooldown_minutes:g} 分钟)",
                flush=True,
            )

        # VOIDMAKER_VOICE_CHAT=1 → 启动即进入连续对话(也用于冒烟验证)
        if os.environ.get("VOIDMAKER_VOICE_CHAT"):
            QTimer.singleShot(0, lambda: self._set_voice_chat(True))

        # VOIDMAKER_PERM_TEST=1 → 注入假权限请求,验证内嵌请示气泡(仅冒烟)
        if os.environ.get("VOIDMAKER_PERM_TEST"):
            QTimer.singleShot(1200, self._inject_fake_permission)

        # 端到端自动验证:启动后自动发送一条消息(延迟可调,避开开场白播放期)
        autosend = os.environ.get("VOIDMAKER_AUTOSEND", "")
        if autosend:
            delay_ms = int(os.environ.get("VOIDMAKER_AUTOSEND_DELAY_MS", "1500"))
            QTimer.singleShot(delay_ms, lambda: self._send_text(autosend))

    # --- 对话流 ---

    def _on_send(self) -> None:
        text = self._input.text().strip()
        if text:
            self._input.clear()
            self._send_text(text)

    def _send_text(self, text: str, image: bytes | None = None) -> None:
        self._history.append("user", text, **({"has_image": True} if image else {}))
        if not self._worker.send(text, image):
            self._on_error("agent 尚未就绪,稍后再试")
            return
        self._input.setPlaceholderText("……")
        self._input.setEnabled(False)
        self._pause_listening()  # 半双工:等待与播报期间不拾音
        self._bc_text = text
        self._bc_timer.start()  # 等待期接话;正式回复先到则取消

    # --- 框选截图 ---

    def _on_snip_clicked(self) -> None:
        if not self._input.isEnabled() or (self._snip is not None and self._snip.isRunning()):
            return
        self._snip_btn.setEnabled(False)
        self._snip = SnipWorker(self)
        self._snip.captured.connect(self._on_snip_captured)
        self._snip.failed.connect(self._on_snip_failed)
        self._snip.start()

    def _on_snip_captured(self, data: bytes) -> None:
        self._snip_btn.setEnabled(True)
        text = self._input.text().strip() or "(看看我框选给你的这块屏幕)"
        self._input.clear()
        self._send_text(text, bytes(data))

    def _on_snip_failed(self, message: str) -> None:
        self._snip_btn.setEnabled(True)
        print(f"[voidmaker] 框选截图取消/失败: {message}", flush=True)

    def _show_backchannel(self) -> None:
        if self._showing or self._segments:
            return  # 正式回复已开始
        choice = self._bc_resolver.resolve(classify(self._bc_text))
        if choice is None:
            return
        template, variant = choice
        print(f"[voidmaker] 接话: [{template.intent}] {variant.zh or variant.ja}", flush=True)
        # 临时段:只走字幕/立绘轻量路径,不进历史、语音队列或分段状态机
        self._bubble_hide_timer.stop()
        self._portrait.set_portrait_for(template.portrait, template.tone)
        self._portrait.pulse()
        if self._bubble_enabled:
            self._bubble.start(variant.zh or variant.ja)

    def _on_segment(self, seg: ReplySegment) -> None:
        self._bc_timer.stop()
        print(f"[voidmaker] 分段: [{seg.tone}] {seg.zh or seg.ja}", flush=True)
        if self._proactive_round:
            self._last_proactive_spoke = time.monotonic()  # 真的开口了才进入冷却
        self._turn_segs.append(seg.model_dump())  # 整轮攒齐,turn_done 时一次落历史
        self._enqueue(seg)

    def _on_usage(self, usage) -> None:
        self._turn_usage = usage

    def _on_turn_done(self) -> None:
        if self._turn_segs:  # 整轮一条 assistant(分段数组 + usage)
            extra = {"usage": self._turn_usage} if self._turn_usage else {}
            self._history.append("assistant", self._turn_segs, **extra)
        self._turn_segs = []
        self._turn_usage = None
        self._proactive_round = False
        self._input.setEnabled(True)
        self._input.setPlaceholderText("和她说点什么…… (Enter 发送)")
        self._input.setFocus()
        self._maybe_resume_listening()

    # --- 主动感知 ---

    def _proactive_tick(self) -> None:
        if not self._input.isEnabled():
            return  # agent 正忙(对话中或上一轮主动检查未完)
        if self._showing:
            return  # 正在播放分段,不打断
        if time.monotonic() - self._last_proactive_spoke < self._cooldown_s:
            return  # 冷却中
        if self._precheck_model is None:
            print("[voidmaker] 主动感知:检查屏幕(主模型)", flush=True)
            self._send_proactive()
            return
        if self._precheck is not None and self._precheck.isRunning():
            return  # 上一轮预判未完
        print(f"[voidmaker] 主动感知:预判({self._precheck_model})", flush=True)
        self._precheck = PrecheckWorker(self._precheck_model, self)
        self._precheck.decided.connect(self._on_precheck_decided)
        self._precheck.start()

    def _on_precheck_decided(self, speak: bool) -> None:
        if not speak:
            print("[voidmaker] 主动感知:预判沉默", flush=True)
            return
        # 预判期间用户可能开始对话/正在播报,重查守卫
        if not self._input.isEnabled() or self._showing:
            return
        print("[voidmaker] 主动感知:预判值得开口,升级主模型", flush=True)
        self._send_proactive()

    def _send_proactive(self) -> None:
        self._proactive_round = True
        if self._worker.send(PROACTIVE_PROMPT):
            self._input.setEnabled(False)  # 占用一轮,防止并发
            self._input.setPlaceholderText("(她瞥了一眼屏幕……)")
        else:
            self._proactive_round = False

    # --- 语音输入 ---

    def _on_mic_clicked(self) -> None:
        if self._voice_chat_on:
            self._set_voice_chat(False)  # 连续对话中,点麦克风 = 退出该模式
            return
        recording = self._stt.toggle()
        self._mic_btn.setChecked(recording)
        self._mic_btn.setText("⏹" if recording else "🎤")
        if not recording:
            self._input.setPlaceholderText("(识别中……)")

    # --- 语音连续对话(半双工:她说话/思考时暂停拾音) ---

    def _set_voice_chat(self, on: bool) -> None:
        if on == self._voice_chat_on:
            return
        if on:
            if self._transcriber is None:
                print("[voidmaker] STT 未启用,无法开启连续对话", flush=True)
                return
            self._voice_chat_on = True
            self._voice_chat = VoiceChatWorker(self._transcriber, self)
            self._voice_chat.utterance.connect(self._on_voice_utterance)
            self._voice_chat.failed.connect(self._on_voice_chat_failed)
            self._voice_chat.start()
            if self._mic_btn is not None:
                self._mic_btn.setChecked(True)
                self._mic_btn.setText("👂")
            print("[voidmaker] 连续对话已开启", flush=True)
            self._maybe_resume_listening()
        else:
            self._voice_chat_on = False
            if self._voice_chat is not None:
                self._voice_chat.stop()  # 结束拾音进程,释放麦克风
                self._voice_chat = None
            if self._mic_btn is not None:
                self._mic_btn.setChecked(False)
                self._mic_btn.setText("🎤")
            if self._input.isEnabled():
                self._input.setPlaceholderText("和她说点什么…… (Enter 发送)")
            print("[voidmaker] 连续对话已关闭", flush=True)

    def _pause_listening(self) -> None:
        if self._voice_chat is not None:
            self._voice_chat.set_listening(False)

    def _maybe_resume_listening(self) -> None:
        """空闲(无对话轮、无分段播放)时恢复拾音。"""
        if not self._voice_chat_on or self._voice_chat is None:
            return
        if self._input.isEnabled() and not self._showing:
            self._voice_chat.set_listening(True)
            self._input.setPlaceholderText("(连续对话中,直接说话……)")

    def _on_voice_utterance(self, text: str) -> None:
        if not self._voice_chat_on:
            return
        if not self._input.isEnabled() or self._showing:
            return  # 半双工竞态:她已开始回应,丢弃迟到的识别结果
        print(f"[voidmaker] 语音: {text}", flush=True)
        self._send_text(text)
        self._input.setPlaceholderText(f"「{text}」……")

    def _on_voice_chat_failed(self, message: str) -> None:
        print(f"[voidmaker] 连续对话: {message}", flush=True)
        if "无法启动" in message or "停止" in message:
            self._set_voice_chat(False)

    def _on_transcribed(self, text: str) -> None:
        # 填入输入条供确认(不直接发送),已有内容则追加
        existing = self._input.text().strip()
        self._input.setText(f"{existing} {text}".strip() if existing else text)
        self._input.setFocus()
        if self._input.isEnabled():
            self._input.setPlaceholderText("和她说点什么…… (Enter 发送)")

    def _on_notepad_request(self, data) -> None:
        title, content, fmt = data
        if self._notepad is None:
            theme = self._card.theme if self._card else {}
            self._notepad = NotepadWindow(theme)
        self._notepad.show_content(title, content, fmt)

    def _on_permission_request(self, request) -> None:
        """未预授权的工具调用 → 内嵌气泡请示(非模态,不遮立绘);多个请求排队逐一问。"""
        self._perm_queue.append(request)
        if self._perm_current is None:
            self._show_next_permission()

    def _show_next_permission(self) -> None:
        if not self._perm_queue:
            self._perm_current = None
            if not self._bubble_enabled:
                self._set_bubble_area_visible(False)  # 请示完毕,收回临时展开的气泡区
            return
        self._pause_listening()
        self._bubble.hide()  # 与字幕互斥,避免叠加
        if not self._bubble_enabled:
            self._set_bubble_area_visible(True)  # 关字幕模式:请示期间临时展开
        self._perm_current = request = self._perm_queue.popleft()
        name = request.tool_name.rsplit("__", 1)[-1]  # mcp__pet__open_url → open_url
        detail = json.dumps(request.tool_input, ensure_ascii=False)
        if len(detail) > 220:  # 工具名始终完整,参数超长则截断预览以保护布局
            detail = detail[:220] + "…"
        self._perm_bubble.ask(name, detail)

    def _on_permission_answered(self, choice: str) -> None:
        if self._perm_current is not None:
            self._perm_current.respond(choice)
            self._perm_current = None
        self._show_next_permission()  # 还有排队的继续问,否则收起

    def _inject_fake_permission(self) -> None:
        class _Fake:
            tool_name = "Bash"
            tool_input = {"command": "rm -rf /tmp/scratch/*"}

            def respond(self, choice):
                print(f"[voidmaker] 假权限请求已回答: {choice}", flush=True)

        self._on_permission_request(_Fake())

    def _on_error(self, message: str) -> None:
        print(f"[voidmaker] 错误: {message}", flush=True)
        self._enqueue(ReplySegment(zh=f"(出错了: {message[:120]})", tone=""))
        self._on_turn_done()

    def _enqueue(self, seg: ReplySegment) -> None:
        self._pause_listening()  # 提醒/主动发言等不经 _send_text 的路径也要停拾音
        self._bubble_hide_timer.stop()  # 新回复来了,取消上一轮的收起倒计时
        seq = self._seq_counter
        self._seq_counter += 1
        # 立即送合成(流水线):显示到该段时音频多半已就绪
        if self._voice is not None and seg.ja and self._voice.prepare(seq, seg.ja, seg.tone):
            pass  # audio_ready 信号回填 _audio_state
        else:
            self._audio_state[seq] = False  # 无语音路径
        self._segments.append((seq, seg))
        if not self._showing:
            self._showing = True
            self._try_start_segment()

    def _try_start_segment(self) -> None:
        """开始队首分段;音频未就绪则挂起等 audio_ready。"""
        if not self._segments:
            self._showing = False
            if self._bubble_hide_ms:
                self._bubble_hide_timer.start(self._bubble_hide_ms)  # 停留后收起气泡
            self._maybe_resume_listening()  # 分段播完,空闲期恢复拾音
            return
        seq, seg = self._segments[0]
        if seq not in self._audio_state:
            self._waiting_seq = seq  # 合成中,等信号
            return
        self._segments.popleft()
        self._waiting_seq = None
        has_audio = self._audio_state.pop(seq)
        self._bubble_done = not self._bubble_enabled  # 关字幕:段推进只看语音
        self._audio_playing = has_audio
        self._portrait.set_portrait_for(seg.portrait, seg.tone)
        self._portrait.pulse()  # 开口轻顶,把动作和这段回复绑定
        if has_audio:
            self._voice.play(seq)
        if self._bubble_enabled:
            self._bubble.start(seg.zh or seg.ja)
        elif not has_audio:
            QTimer.singleShot(0, self._maybe_advance)  # 无字幕也无语音,直接推进

    def _on_audio_ready(self, seq: int, ok: bool) -> None:
        self._audio_state[seq] = ok
        if self._waiting_seq == seq:
            self._try_start_segment()

    def _on_playback_done(self, seq: int) -> None:
        self._audio_playing = False
        self._maybe_advance()

    def _on_bubble_finished(self) -> None:
        self._bubble_done = True
        self._maybe_advance()

    def _maybe_advance(self) -> None:
        # 段完成 = 字幕走完 且 语音播完(无语音段只看字幕)
        if self._bubble_done and not self._audio_playing:
            self._try_start_segment()

    # --- 窗口交互 ---

    def toggle_visible(self) -> None:
        """快捷键:收起/唤出(进程常驻,保留对话与缓存)。"""
        if self.isVisible():
            self.hide()
            if self._voice_chat is not None:
                self._voice_chat.set_listening(False)  # 收起时别再拾音
        else:
            self.show()
            self.raise_()
            self.activateWindow()
            self._maybe_resume_listening()

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._bubble.flush()  # 点击跳过打字机
            self.windowHandle().startSystemMove()

    def contextMenuEvent(self, event) -> None:
        menu = QMenu(self)
        auto_action = QAction("自动允许工具(不再确认)", menu)
        auto_action.setCheckable(True)
        auto_action.setChecked(self._permissions.auto)
        auto_action.toggled.connect(self._permissions.set_auto)
        menu.addAction(auto_action)
        menu.addSeparator()
        if self._transcriber is not None:
            voice_chat_action = QAction("语音连续对话", menu)
            voice_chat_action.setCheckable(True)
            voice_chat_action.setChecked(self._voice_chat_on)
            voice_chat_action.toggled.connect(self._set_voice_chat)
            menu.addAction(voice_chat_action)
            menu.addSeparator()
        quit_action = QAction("退出", menu)
        quit_action.triggered.connect(self.close)
        menu.addAction(quit_action)
        menu.exec(event.globalPos())

    def _refit_window(self) -> None:
        # 显隐事件对布局的标脏是异步的:先显式 invalidate 再取 sizeHint,
        # 否则拿到缓存旧值,setFixedSize 原地踏步
        self.layout().invalidate()
        self.setFixedSize(self.layout().sizeHint())

    def _set_input_bar_visible(self, visible: bool) -> None:
        if visible == self._input_bar.isVisibleTo(self):
            return
        self._input_bar.setVisible(visible)
        self._refit_window()

    def _set_bubble_area_visible(self, visible: bool) -> None:
        if visible == self._bubble_area.isVisibleTo(self):
            return
        self._bubble_area.setVisible(visible)
        self._refit_window()

    def changeEvent(self, event) -> None:
        # 输入条随窗口焦点显隐(niri 点击窗口即聚焦,点别处即失焦)
        if event.type() == QEvent.Type.ActivationChange and self._input_focus_only:
            self._set_input_bar_visible(self.isActiveWindow())
        super().changeEvent(event)

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()

    def closeEvent(self, event) -> None:
        if self._notepad is not None:
            self._notepad.close()
        if self._curator.isRunning():
            self._curator.wait(10000)
        if self._precheck is not None and self._precheck.isRunning():
            self._precheck.wait(5000)
        if self._snip is not None and self._snip.isRunning():
            self._snip.wait(2000)
        if self._voice_chat is not None:
            self._voice_chat.stop()
        if self._stt is not None:
            self._stt.stop()
        if self._voice is not None:
            self._voice.stop()
        self._worker.stop()
        super().closeEvent(event)
