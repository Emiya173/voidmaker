"""内置工具:进程内 MCP server(Claude Agent SDK @tool)。

- take_screenshot:grim 全屏截图,以图片内容块返回给模型(她能看到屏幕)
- write_note / read_notes:markdown 笔记(data 目录)
- set_reminder:相对时间提醒;调度交给宿主(UI 用 QTimer,CLI 用 event loop),
  到点后宿主把提醒文本注入对话,由模型生成角色化提醒语
- remember:追加一条跨会话长期记忆(区别于笔记:笔记是替用户记的事项,
  记忆是角色对用户的了解,注入下次会话的系统提示)
- list_windows:niri 查当前窗口(比截屏快省,不涉及画面);notify:桌面通知
"""

from __future__ import annotations

import base64
import datetime as _dt
import re
from collections.abc import Callable
from pathlib import Path

from claude_agent_sdk import create_sdk_mcp_server, tool

from ..config import DATA_DIR
from ..perception.desktop import (
    format_focused_window,
    format_now_playing,
    format_windows,
    open_with_default,
    query_focused_window,
    query_windows,
    read_clipboard,
    read_now_playing,
    send_notification,
)
from ..perception.homelab import fetch_status, format_status, load_topology
from ..perception.screenshot import capture_fullscreen
from ..storage.memory import CharacterMemory

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

NOTES_PATH = DATA_DIR / "notes.md"

# 宿主注册的提醒回调: (提醒内容, 延迟秒数) -> None
ReminderScheduler = Callable[[str, float], None]


def build_pet_server(
    schedule_reminder: ReminderScheduler | None = None,
    memory: CharacterMemory | None = None,
    homelab_url: str | None = None,
    show_notepad: Callable[[str, str, str], None] | None = None,
):
    """构造进程内 MCP server。返回 (server, allowed_tool_names)。

    homelab_url 非空时注册家庭服务器状态/拓扑工具(只读)。
    show_notepad 非空时注册记事窗口工具。
    """

    @tool("take_screenshot", "截取当前屏幕画面。当需要了解用户正在做什么、查看屏幕内容时使用。", {})
    async def take_screenshot(args: dict):
        try:
            path = await capture_fullscreen()
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"截图失败: {exc}"}], "is_error": True}
        try:
            data = base64.standard_b64encode(path.read_bytes()).decode()
        finally:
            path.unlink(missing_ok=True)
        return {"content": [{"type": "image", "data": data, "mimeType": "image/jpeg"}]}

    @tool("write_note", "追加一条笔记(帮用户记录事项、想法、待办)。", {"content": str})
    async def write_note(args: dict):
        content = str(args.get("content", "")).strip()
        if not content:
            return {"content": [{"type": "text", "text": "内容为空,未记录"}], "is_error": True}
        NOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
        stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        with NOTES_PATH.open("a", encoding="utf-8") as f:
            f.write(f"- [{stamp}] {content}\n")
        return {"content": [{"type": "text", "text": "已记录"}]}

    @tool("read_notes", "读取全部笔记。", {})
    async def read_notes(args: dict):
        text = NOTES_PATH.read_text(encoding="utf-8") if NOTES_PATH.exists() else "(暂无笔记)"
        return {"content": [{"type": "text", "text": text}]}

    @tool(
        "set_reminder",
        "设置提醒。minutes 为多少分钟后提醒(支持小数),content 为提醒内容。到点后你会收到提示,届时用角色语气提醒用户。",
        {"minutes": float, "content": str},
    )
    async def set_reminder(args: dict):
        if schedule_reminder is None:
            return {"content": [{"type": "text", "text": "当前模式不支持提醒"}], "is_error": True}
        try:
            minutes = float(args.get("minutes", 0))
        except (TypeError, ValueError):
            minutes = 0
        content = str(args.get("content", "")).strip()
        if minutes <= 0 or not content:
            return {"content": [{"type": "text", "text": "参数无效:需要 minutes>0 和 content"}], "is_error": True}
        schedule_reminder(content, minutes * 60)
        return {"content": [{"type": "text", "text": f"好,{minutes} 分钟后提醒:{content}"}]}

    @tool(
        "remember",
        "记住关于用户的长期事实(身份、偏好、在做的项目、重要约定)。"
        "写入你的跨会话记忆,下次见面仍然记得。一次记一条,简短陈述句。",
        {"content": str},
    )
    async def remember(args: dict):
        if memory is None:
            return {"content": [{"type": "text", "text": "当前模式不支持长期记忆"}], "is_error": True}
        content = str(args.get("content", "")).strip()
        if not content:
            return {"content": [{"type": "text", "text": "内容为空,未记录"}], "is_error": True}
        memory.append(content)
        return {"content": [{"type": "text", "text": "已记住"}]}

    @tool(
        "list_windows",
        "查看用户当前打开了哪些窗口(应用名+标题,▶ 标记当前聚焦)。"
        "想了解用户在做什么、而不需要看具体画面内容时,优先用它——比截屏快得多也省。",
        {},
    )
    async def list_windows(args: dict):
        try:
            windows = await query_windows()
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"查窗口失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": format_windows(windows)}]}

    @tool(
        "notify",
        "发送一条桌面通知(title 标题,body 正文)。用户可能没盯着桌宠窗口时,"
        "重要提醒/事项用它比只在对话里说更醒目。",
        {"title": str, "body": str},
    )
    async def notify(args: dict):
        title = str(args.get("title", "")).strip() or "夜乃樱"
        body = str(args.get("body", "")).strip()
        try:
            await send_notification(title, body)
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"通知失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": "已发送桌面通知"}]}

    @tool(
        "focused_window",
        "查看用户当前正聚焦(正在操作)的那一个窗口。比 list_windows 更轻,"
        "只想知道'用户此刻在哪个应用'时用它。",
        {},
    )
    async def focused_window(args: dict):
        try:
            win = await query_focused_window()
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"查聚焦窗口失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": format_focused_window(win)}]}

    @tool(
        "open_url",
        "在默认浏览器打开一个网址(仅限 http/https)。用户让你打开某网站时使用。",
        {"url": str},
    )
    async def open_url(args: dict):
        url = str(args.get("url", "")).strip()
        if not _URL_RE.match(url):
            return {"content": [{"type": "text", "text": "只支持 http/https 网址"}], "is_error": True}
        try:
            await open_with_default(url)
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"打开失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": f"已在浏览器打开 {url}"}]}

    @tool(
        "open_path",
        "用默认应用打开本地文件或目录(图片→看图器,pdf/网页→浏览器,目录→文件管理器)。",
        {"path": str},
    )
    async def open_path(args: dict):
        raw = str(args.get("path", "")).strip()
        if not raw:
            return {"content": [{"type": "text", "text": "路径为空"}], "is_error": True}
        path = Path(raw).expanduser()
        if not path.exists():
            return {"content": [{"type": "text", "text": f"路径不存在: {path}"}], "is_error": True}
        try:
            await open_with_default(str(path))
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"打开失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": f"已打开 {path}"}]}

    @tool(
        "now_playing",
        "查看用户当前正在播放的媒体(歌曲/视频:标题、艺术家、播放器、进度)。"
        "用户问'我在听/看什么'或你想聊聊正在播放的内容时用。",
        {},
    )
    async def now_playing(args: dict):
        try:
            info = await read_now_playing()
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"读媒体状态失败: {exc}"}], "is_error": True}
        return {"content": [{"type": "text", "text": format_now_playing(info)}]}

    @tool(
        "read_clipboard",
        "读取用户当前剪贴板里的文本(用户让你看'我复制的内容'时使用)。",
        {},
    )
    async def read_clipboard_tool(args: dict):
        try:
            text = await read_clipboard()
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"读剪贴板失败: {exc}"}], "is_error": True}
        if not text.strip():
            return {"content": [{"type": "text", "text": "(剪贴板为空或不是文本)"}]}
        return {"content": [{"type": "text", "text": text}]}

    tools = [
        take_screenshot, write_note, read_notes, set_reminder, remember,
        list_windows, notify, focused_window, now_playing,
        open_url, open_path, read_clipboard_tool,
    ]

    if show_notepad is not None:
        @tool(
            "show_notepad",
            "在独立记事窗口展示整理好的较长/结构化内容,不塞进聊天气泡、也不读出来。"
            "适合:终端输出或日志(format=text)、markdown 文档/清单/代码/表格"
            "(format=markdown)、HTML 富文本(format=html)。想给用户看网页内容时,"
            "先用工具抓取再以 markdown/html 展示;交互式浏览仍用 open_url。",
            {"title": str, "content": str, "format": str},
        )
        async def show_notepad_tool(args: dict):
            content = str(args.get("content", ""))
            if not content.strip():
                return {"content": [{"type": "text", "text": "内容为空,未展示"}], "is_error": True}
            fmt = str(args.get("format", "markdown")).strip().lower()
            if fmt not in ("text", "markdown", "html"):
                fmt = "markdown"
            show_notepad(str(args.get("title", "")).strip(), content, fmt)
            return {"content": [{"type": "text", "text": "已在记事窗口展示"}]}

        tools.append(show_notepad_tool)

    if homelab_url:
        @tool(
            "homelab_status",
            "查看用户家庭服务器的实时状态:Jellyfin(媒体库/在放什么)、Immich(相册)、"
            "qBittorrent(下载)、追番订阅。用户问'家里服务器/番下好了吗/相册多满了'时用。",
            {},
        )
        async def homelab_status(args: dict):
            payload = await fetch_status(homelab_url)
            return {"content": [{"type": "text", "text": format_status(payload)}]}

        @tool(
            "homelab_topology",
            "查看家庭服务器的网络拓扑与服务分布参考(三台机的角色、连通性约束、已知隐患)。"
            "需要理解'家里的网络/服务怎么组织的'来回答问题时用。",
            {},
        )
        async def homelab_topology(args: dict):
            topo = load_topology()
            if not topo:
                topo = "(未配置拓扑参考:在 ~/.config/voidmaker/homelab.md 写入家庭网络/服务分布即可)"
            return {"content": [{"type": "text", "text": topo}]}

        tools += [homelab_status, homelab_topology]
    server = create_sdk_mcp_server(name="pet", version="1.0.0", tools=tools)
    allowed = [f"mcp__pet__{t.name}" for t in tools]
    return server, allowed
