"""Qt 应用入口:app-id 固定为 voidmaker,供 niri window-rule 匹配。"""

from __future__ import annotations

import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QApplication

from ..character.loader import scan_characters
from ..config import AppConfig
from .ipc import ControlServer, send_ctl
from .pet_window import PetWindow


def run_app(cfg: AppConfig) -> int:
    # 分数缩放(如 niri 1.5x)用 PassThrough,不向上取整到 2x:立绘/字幕按真实
    # dpr 像素级渲染,更锐。必须在 QApplication 创建前设置。
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )
    # Wayland 的 app_id 取自 desktopFileName,必须在窗口创建前设置
    QGuiApplication.setDesktopFileName("voidmaker")
    app = QApplication(sys.argv)
    app.setApplicationName("voidmaker")

    # 单例:已有实例在跑 → 让启动快捷键变成「收起/唤出」开关,自己退出。
    if send_ctl("toggle"):
        print("[voidmaker] 已有实例,已切换显隐", flush=True)
        return 0

    cards = scan_characters(cfg.characters_dir)
    card = None
    if cards:
        card = cards.get(cfg.current_character or "") or next(iter(cards.values()))
        print(f"[voidmaker] 角色: {card.display_name} ({card.id})", flush=True)
    else:
        print("[voidmaker] 未找到角色包,显示占位立绘", flush=True)

    window = PetWindow(card, cfg)
    window.show()

    # 控制通道:接收后续启动/退出快捷键发来的命令。
    def _on_command(cmd: str) -> None:
        if cmd == "toggle":
            window.toggle_visible()
        elif cmd == "quit":
            app.quit()

    server = ControlServer(_on_command)

    code = app.exec()
    server.close()
    return code
