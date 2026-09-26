"""Quickshell 与现有 agent/语音控制器间的 JSON lines 桥接。"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from PIL import Image
from PySide6.QtCore import QSocketNotifier, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QApplication

from ..character.loader import scan_characters
from ..character.model import CharacterCard
from ..config import AppConfig
from .ipc import ControlServer
from .pet_window import PetWindow
from .tray import create_tray


def _portrait_uri(window: PetWindow) -> str:
    path = window._portrait._path
    return path.as_uri() if path is not None and path.is_file() else ""


def create_preview(data: bytes, directory: Path) -> str:
    """生成仅供侧栏显示的小图；原始 PNG 仍完整交给 agent。"""
    with Image.open(BytesIO(data)) as source:
        source.thumbnail((320, 200))
        preview = source.convert("RGB")
    path = directory / f"{uuid4().hex}.jpg"
    preview.save(path, format="JPEG", quality=75)
    return path.as_uri()


def _write_event(event: dict) -> None:
    try:
        os.write(1, (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
    except BrokenPipeError:
        QApplication.quit()


class ShellController(PetWindow):
    """复用已验证的对话状态机；Qt 窗口始终不显示，视图交给 Quickshell。"""

    def __init__(self, card: CharacterCard | None, cfg: AppConfig, emit: Callable[[dict], None]):
        super().__init__(card, cfg)
        self._preview_dir = TemporaryDirectory(prefix="voidmaker-preview-")
        self._emit_event = emit
        self._publish({
            "type": "hello",
            "name": card.display_name if card else "VoidMaker",
            "portrait": _portrait_uri(self),
            "bubble_enabled": self._bubble_enabled,
            "stt_enabled": self._stt is not None,
            "casual_chat": self._casual_chat_enabled,
            "auto_permissions": self._permissions.auto,
            "greeting": self._bubble._target if self._bubble_enabled else "",
        })

    def _publish(self, event: dict) -> None:
        emit = getattr(self, "_emit_event", None)
        if emit is not None:
            emit(event)

    def _publish_portrait(self) -> None:
        self._publish({"type": "portrait", "path": _portrait_uri(self)})

    def _show_bubble_text(self, text: str) -> None:
        super()._show_bubble_text(text)
        self._publish({"type": "bubble", "text": text})

    def _hide_bubble(self) -> None:
        super()._hide_bubble()
        self._publish({"type": "bubble_hide"})

    def _show_backchannel(self) -> None:
        super()._show_backchannel()
        self._publish_portrait()

    def _try_start_segment(self) -> None:
        super()._try_start_segment()
        self._publish_portrait()

    def _send_text(self, text: str, image: bytes | None = None) -> None:
        preview = ""
        if image:
            try:
                preview = create_preview(image, Path(self._preview_dir.name))
            except (OSError, ValueError) as exc:
                print(f"[voidmaker] 截图预览生成失败: {exc}", flush=True)
        super()._send_text(text, image)
        self._publish({"type": "message", "role": "user", "text": text, "image": preview})
        self._publish({"type": "busy", "value": not self._input.isEnabled()})

    def _on_segment(self, seg) -> None:
        super()._on_segment(seg)
        self._publish({
            "type": "message", "role": "assistant", "text": seg.zh or seg.ja,
            "ja": seg.ja, "tone": seg.tone,
        })

    def _on_turn_done(self) -> None:
        super()._on_turn_done()
        self._publish({"type": "busy", "value": False})

    def _send_proactive(self) -> None:
        super()._send_proactive()
        self._publish({"type": "busy", "value": not self._input.isEnabled()})

    def _on_error(self, message: str) -> None:
        self._publish({"type": "error", "text": message})
        super()._on_error(message)

    def _show_next_permission(self) -> None:
        super()._show_next_permission()
        request = self._perm_current
        if request is None:
            self._publish({"type": "permission_hide"})
        else:
            self._publish({"type": "bubble_hide"})
            detail = json.dumps(request.tool_input, ensure_ascii=False)
            self._publish({
                "type": "permission", "tool": request.tool_name.rsplit("__", 1)[-1],
                "detail": detail[:220] + ("…" if len(detail) > 220 else ""),
            })

    def _on_notepad_request(self, data) -> None:
        title, content, fmt = data
        self._publish({"type": "notepad", "title": title, "content": content, "format": fmt})

    def _on_snip_captured(self, data: bytes) -> None:
        super()._on_snip_captured(data)
        self._publish({"type": "draft", "text": ""})
        self._publish({"type": "snip_done", "ok": True})

    def _on_snip_failed(self, message: str) -> None:
        super()._on_snip_failed(message)
        self._publish({"type": "snip_done", "ok": False})

    def start_snip(self, text: str) -> None:
        if not self._input.isEnabled() or (self._snip is not None and self._snip.isRunning()):
            self._publish({"type": "snip_done", "ok": False})
            return
        self._input.setText(text[:10000])
        self._on_snip_clicked()

    def _on_transcribed(self, text: str) -> None:
        super()._on_transcribed(text)
        self._publish({"type": "draft", "text": self._input.text()})

    def _on_mic_clicked(self) -> None:
        super()._on_mic_clicked()
        self._publish({"type": "recording", "value": self._stt.recording if self._stt else False})

    def _set_voice_chat(self, on: bool) -> None:
        super()._set_voice_chat(on)
        self._publish({"type": "voice_chat", "value": self._voice_chat_on})

    def _set_casual_chat(self, enabled: bool) -> bool:
        ok = super()._set_casual_chat(enabled)
        if ok:
            self._publish({"type": "casual_chat", "value": self._casual_chat_enabled})
        return ok

    def _set_auto_permissions(self, enabled: bool) -> None:
        self._permissions.set_auto(enabled)
        self._publish({"type": "auto_permissions", "value": self._permissions.auto})

    def toggle_visible(self) -> None:
        self._publish({"type": "visibility"})

    def closeEvent(self, event) -> None:
        self._publish({"type": "quit"})
        super().closeEvent(event)
        self._preview_dir.cleanup()
        QApplication.quit()


class StdinCommands:
    def __init__(self, handle: Callable[[dict], None]):
        self._handle = handle
        self._buffer = bytearray()
        self._fd = sys.stdin.fileno()
        os.set_blocking(self._fd, False)
        self._notifier = QSocketNotifier(self._fd, QSocketNotifier.Type.Read)
        self._notifier.activated.connect(self._read)

    def _read(self) -> None:
        try:
            chunk = os.read(self._fd, 8192)
        except BlockingIOError:
            return
        if not chunk:
            self._notifier.setEnabled(False)
            QApplication.quit()
            return
        self._buffer.extend(chunk)
        while b"\n" in self._buffer:
            line, _, rest = self._buffer.partition(b"\n")
            self._buffer = bytearray(rest)
            try:
                command = json.loads(line)
                if isinstance(command, dict):
                    self._handle(command)
            except (UnicodeError, json.JSONDecodeError):
                continue


def handle_command(window: ShellController, data: dict, quit_app: Callable[[], None]) -> None:
    """处理来自 Quickshell 的单条命令，仅接受已知操作和有效参数。"""
    name = data.get("cmd")
    if name == "send" and isinstance(data.get("text"), str):
        message = data["text"].strip()
        if message and window._input.isEnabled():
            window._send_text(message[:10000])
    elif name == "permission" and data.get("choice") in ("deny", "once", "always"):
        if window._perm_current is not None:
            window._on_permission_answered(data["choice"])
    elif name == "mic" and window._stt is not None:
        window._on_mic_clicked()
    elif name == "voice_chat":
        window._set_voice_chat(bool(data.get("value")))
    elif name == "casual_chat":
        window._set_casual_chat(bool(data.get("value")))
    elif name == "auto_permissions":
        window._set_auto_permissions(bool(data.get("value")))
    elif name == "snip":
        window.start_snip(str(data.get("text", "")))
    elif name == "quit":
        quit_app()


def run_bridge(cfg: AppConfig) -> int:
    # stdout 保留给协议；PetWindow 和 worker 的诊断打印转去 stderr。
    sys.stdout = sys.stderr
    for name in ("QT_PLUGIN_PATH", "QT_QPA_PLATFORMTHEME", "QT_STYLE_OVERRIDE"):
        os.environ.pop(name, None)
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    QGuiApplication.setDesktopFileName("voidmaker")
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    cards = scan_characters(cfg.characters_dir)
    card = cards.get(cfg.current_character or "") or next(iter(cards.values()), None)
    window = ShellController(card, cfg, _write_event)

    stdin = StdinCommands(lambda data: handle_command(window, data, app.quit))  # noqa: F841 — 保留 notifier 生命期

    def on_control(cmd: str) -> None:
        if cmd == "toggle":
            _write_event({"type": "toggle"})
        elif cmd == "quit":
            _write_event({"type": "quit"})
            app.quit()

    server = ControlServer(on_control)
    tray = create_tray(window)  # noqa: F841 — 保留托盘图标生命期
    code = app.exec()
    window.close()
    server.close()
    return code
