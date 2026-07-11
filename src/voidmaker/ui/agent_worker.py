"""Agent 后台线程:QThread 内跑 asyncio 事件循环,桥接 CharacterAgent 与 Qt 信号。

Qt 主线程通过 send() 投递用户消息;分段回复经 segment_ready 信号(队列连接,线程安全)
回到主线程驱动气泡/立绘。未预授权的工具调用经 permission_request 信号请求主线程
确认,asyncio 侧 await Future 挂起等答复。
"""

from __future__ import annotations

import asyncio

from PySide6.QtCore import QThread, Signal

from ..agent.client import CharacterAgent
from ..character.model import CharacterCard
from ..config import AgentConfig
from ..storage.memory import CharacterMemory
from ..storage.permissions import PermissionStore

_STOP = object()


class PermissionRequest:
    """跨线程权限询问:主线程 UI 调 respond(choice),asyncio 侧 await future。

    choice: "once"(仅这次) | "session"(本次都允许) | "deny"(拒绝)。
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, tool_name: str, tool_input: dict):
        self.tool_name = tool_name
        self.tool_input = tool_input
        self._loop = loop
        self.future: asyncio.Future[str] = loop.create_future()

    def respond(self, choice: str) -> None:
        def _set() -> None:
            if not self.future.done():
                self.future.set_result(choice)

        self._loop.call_soon_threadsafe(_set)


class AgentWorker(QThread):
    segment_ready = Signal(object)  # ReplySegment
    turn_done = Signal()
    failed = Signal(str)
    permission_request = Signal(object)  # PermissionRequest
    notepad_request = Signal(object)  # (title, content, format)
    usage_ready = Signal(object)  # 上一轮 usage dict(缓存命中诊断)

    def __init__(
        self,
        card: CharacterCard | None,
        cfg: AgentConfig,
        memory: CharacterMemory | None = None,
        permissions: PermissionStore | None = None,
        homelab_url: str | None = None,
        parent=None,
    ):
        super().__init__(parent)
        self._card = card
        self._cfg = cfg
        self._memory = memory
        self._permissions = permissions
        self._homelab_url = homelab_url
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue | None = None
        self._ready = False

    def run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue()
        self._ready = True

        def schedule_reminder(content: str, delay_s: float) -> None:
            # 工具 handler 在本事件循环内调用;到点把提醒注入对话,
            # 由模型生成角色化提醒 → 走既有分段/气泡/语音链路
            self._loop.call_later(
                delay_s,
                self._queue.put_nowait,
                f"(系统提示:你之前设置的提醒到点了——「{content}」。请用角色语气主动提醒用户,不要提到本条系统提示。)",
            )

        async def ask_permission(tool_name: str, tool_input: dict) -> str:
            request = PermissionRequest(self._loop, tool_name, tool_input)
            self.permission_request.emit(request)
            return await request.future

        def show_notepad(title: str, content: str, fmt: str) -> None:
            # agent 线程调用;信号跨线程投递到主线程建/更新 notepad 窗口
            self.notepad_request.emit((title, content, fmt))

        try:
            async with CharacterAgent(
                self._card, self._cfg, schedule_reminder, self._memory,
                ask_permission, self._permissions, self._homelab_url, show_notepad,
            ) as agent:
                while True:
                    item = await self._queue.get()
                    if item is _STOP:
                        return
                    # 队列项:纯文本(用户消息/提醒注入)或 (文本, 图片字节) 元组
                    text, image = item if isinstance(item, tuple) else (item, None)
                    try:
                        async for seg in agent.chat(text, image=image):
                            self.segment_ready.emit(seg)
                        self.usage_ready.emit(agent.last_usage)
                    except Exception as exc:  # 单轮失败不终止会话
                        self.failed.emit(str(exc))
                    self.turn_done.emit()
        except Exception as exc:
            self.failed.emit(f"agent 会话启动失败: {exc}")

    def _post(self, item) -> bool:
        if not self._ready or self._loop is None or self._queue is None:
            return False
        self._loop.call_soon_threadsafe(self._queue.put_nowait, item)
        return True

    def send(self, text: str, image: bytes | None = None) -> bool:
        return self._post((text, image) if image is not None else text)

    def stop(self) -> None:
        self._post(_STOP)
        self.wait(5000)
