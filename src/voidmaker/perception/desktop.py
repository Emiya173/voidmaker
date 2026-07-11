"""桌面交互(niri/Wayland,本机 NixOS 配置):窗口查询 + 桌面通知。

窗口查询走 `niri msg -j windows`(比截屏快、省 token、不涉及画面隐私),
通知走 `notify-send`(用户没盯着桌宠窗口时更醒目)。命令不可用时优雅报错。
"""

from __future__ import annotations

import asyncio
import json


def format_windows(windows: list[dict]) -> str:
    """把 niri 窗口 JSON 列表格式化成可读文本(纯函数,便于单测)。"""
    if not windows:
        return "当前没有打开的窗口"
    lines = ["当前打开的窗口:"]
    for w in windows:
        mark = "▶ " if w.get("is_focused") else "  "
        app = w.get("app_id") or "?"
        title = (w.get("title") or "").strip()
        lines.append(f"{mark}{app}: {title}" if title else f"{mark}{app}")
    return "\n".join(lines)


async def query_windows() -> list[dict]:
    """当前所有窗口(app_id/title/is_focused)。niri 不可用时抛 RuntimeError。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "niri", "msg", "-j", "windows",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("niri 不可用(非 niri 会话?)") from exc
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"niri msg 退出码 {proc.returncode}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError("niri 输出解析失败") from exc
    return data if isinstance(data, list) else []


def format_focused_window(win: dict | None) -> str:
    """格式化当前聚焦窗口(纯函数)。niri 无聚焦窗口时 win 为 None。"""
    if not win:
        return "当前没有聚焦的窗口"
    app = win.get("app_id") or "?"
    title = (win.get("title") or "").strip()
    return f"当前聚焦:{app}: {title}" if title else f"当前聚焦:{app}"


async def query_focused_window() -> dict | None:
    """当前聚焦窗口(app_id/title),无则 None。niri 不可用时抛 RuntimeError。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "niri", "msg", "-j", "focused-window",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("niri 不可用(非 niri 会话?)") from exc
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"niri msg 退出码 {proc.returncode}")
    try:
        data = json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError("niri 输出解析失败") from exc
    return data if isinstance(data, dict) else None


async def open_with_default(target: str) -> None:
    """用默认应用打开 URL 或本地路径(xdg-open,遵循用户 mimeApps 配置)。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "xdg-open", target,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("xdg-open 不可用") from exc
    code = await proc.wait()
    if code != 0:
        raise RuntimeError(f"xdg-open 退出码 {code}")


async def read_clipboard() -> str:
    """当前剪贴板文本(wl-paste)。剪贴板为空返回空串;wl-paste 缺失抛 RuntimeError。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "wl-paste", "--no-newline", "--type", "text",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("wl-paste 不可用") from exc
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return ""  # 剪贴板空时 wl-paste 返回非零,不算错误
    return out.decode("utf-8", errors="replace")


# playerctl 单行输出模板,字段用 \x1f(单元分隔符)隔开,避免与内容冲突
_NP_FIELDS = ("status", "player", "artist", "title", "album", "position", "length")
_NP_FORMAT = (
    "{{status}}\x1f{{playerName}}\x1f{{artist}}\x1f{{title}}\x1f{{album}}"
    "\x1f{{duration(position)}}\x1f{{duration(mpris:length)}}"
)


def format_now_playing(info: dict | None) -> str:
    """格式化当前播放媒体(纯函数)。None / 已停止 → 无播放。"""
    if not info or info.get("status") == "Stopped":
        return "当前没有在播放的媒体"
    icon = {"Playing": "▶", "Paused": "⏸"}.get(info.get("status", ""), "■")
    head = (info.get("title") or "").strip() or "(未知曲目)"
    artist = (info.get("artist") or "").strip()
    if artist:
        head += f" — {artist}"
    tail = []
    if info.get("player"):
        tail.append(info["player"])
    pos, length = (info.get("position") or "").strip(), (info.get("length") or "").strip()
    if pos and length:
        tail.append(f"{pos}/{length}")
    return f"{icon} {head}" + (f" [{' · '.join(tail)}]" if tail else "")


async def read_now_playing() -> dict | None:
    """当前 MPRIS 播放状态(playerctl)。无播放器返回 None;playerctl 缺失抛 RuntimeError。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "playerctl", "metadata", "--format", _NP_FORMAT,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("playerctl 不可用") from exc
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None  # No players found
    parts = out.decode("utf-8", errors="replace").rstrip("\n").split("\x1f")
    info = {f: (parts[i] if i < len(parts) else "") for i, f in enumerate(_NP_FIELDS)}
    if not (info.get("title") or info.get("artist")):
        return None  # 有播放器但无有意义元数据
    return info


async def send_notification(title: str, body: str) -> None:
    """发送桌面通知。notify-send 不可用时抛 RuntimeError。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            "notify-send", "-a", "VoidMaker", title, body,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("notify-send 不可用") from exc
    code = await proc.wait()
    if code != 0:
        raise RuntimeError(f"notify-send 退出码 {code}")
