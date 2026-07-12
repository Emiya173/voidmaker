"""系统托盘:显隐开关、常用设置、退出(镜像桌宠右键菜单)。

Wayland 托盘走 StatusNotifierItem,需要有宿主(dms/waybar 的 tray 模块等);
没有宿主时静默跳过,不影响其他功能。

图标必须直接从包内文件加载,不能 QIcon.fromTheme:带主题名的图标经 SNI
上报 IconName,宿主会优先按名字在​自己的(可能是启动时缓存的旧)主题里解析,
解析不到就落回默认图标;纯文件 QIcon 的 name 为空,宿主只能用我们发的像素。

角色立绘版 PNG(assets/voidmaker.png + assets/tray/)是二创资产不入 git,
公开仓库回退内置 SVG。
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtGui import QAction, QIcon
from PySide6.QtWidgets import QMenu, QSystemTrayIcon

ASSETS = Path(__file__).resolve().parent.parent / "assets"


def app_icon() -> QIcon:
    png = ASSETS / "voidmaker.png"
    return QIcon(str(png if png.exists() else ASSETS / "voidmaker.svg"))


def tray_icon() -> QIcon:
    """托盘专用多尺寸 PNG(16-32px 下比整幅立绘缩略清晰);没有则同 app_icon。"""
    files = sorted((ASSETS / "tray").glob("*.png")) if (ASSETS / "tray").is_dir() else []
    if not files:
        return app_icon()
    icon = QIcon()
    for f in files:
        icon.addFile(str(f))
    return icon


def create_tray(window) -> QSystemTrayIcon | None:
    """给桌宠窗口挂托盘;无托盘宿主返回 None。返回值需持有引用防回收。"""
    if not QSystemTrayIcon.isSystemTrayAvailable():
        print("[voidmaker] 无系统托盘宿主,跳过托盘图标", flush=True)
        return None

    tray = QSystemTrayIcon(tray_icon(), window)
    tray.setToolTip("VoidMaker")
    menu = QMenu(window)

    toggle = menu.addAction("显示 / 隐藏")
    toggle.triggered.connect(window.toggle_visible)
    menu.addSeparator()

    auto = QAction("自动允许工具(不再确认)", menu)
    auto.setCheckable(True)
    auto.toggled.connect(window._permissions.set_auto)
    menu.addAction(auto)

    voice = None
    if window._transcriber is not None:
        voice = QAction("语音连续对话", menu)
        voice.setCheckable(True)
        voice.toggled.connect(window._set_voice_chat)
        menu.addAction(voice)
    menu.addSeparator()

    quit_action = menu.addAction("退出")
    quit_action.triggered.connect(window.close)

    def _sync_checks() -> None:
        # 状态可能已被右键菜单改过;blockSignals 防 setChecked 触发一次多余 toggled
        for action, value in ((auto, window._permissions.auto),
                              (voice, window._voice_chat_on)):
            if action is None:
                continue
            action.blockSignals(True)
            action.setChecked(value)
            action.blockSignals(False)

    menu.aboutToShow.connect(_sync_checks)
    tray.setContextMenu(menu)

    def _on_activated(reason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:  # 左键单击
            window.toggle_visible()

    tray.activated.connect(_on_activated)
    tray.show()
    return tray
