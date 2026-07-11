"""Claude Agent SDK 封装:角色化多轮会话。

取代旧 sakura 的 AgentRuntime/ToolRegistry/MCP 桥:agent loop、工具循环、
MCP 接入、权限回调全部由 SDK 提供,这里只做角色系统提示组装与回复解析。
"""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
)

from ..character.model import CharacterCard
from ..config import AgentConfig
from ..storage.memory import CharacterMemory
from ..storage.permissions import PermissionStore
from .reply import SEGMENT_FORMAT_INSTRUCTION, ReplySegment, parse_segments
from .tools import ReminderScheduler, build_pet_server

# 宿主提供的权限确认: (工具名, 输入) -> "once"|"always"|"deny"。
# None = 未预授权且非静默的工具一律拒绝。
PermissionHandler = Callable[[str, dict[str, Any]], Awaitable[str]]

# 只读/无副作用的 CLI 内置工具:静默放行,不打扰用户。
# 其余(Bash/Write/Edit/联网等有副作用或不可判定的)一律询问。
SILENT_TOOLS = frozenset({"Read", "Glob", "Grep", "NotebookRead", "TodoWrite"})

# 敏感的 pet 内置工具:虽是内置,但涉及外向操作或隐私,仍需用户确认。
# (其余 pet 工具——截屏/笔记/提醒/记忆/查窗口/通知——benign,静默。)
SENSITIVE_PET_TOOLS = frozenset({"open_url", "open_path", "read_clipboard"})


def needs_confirmation(tool_name: str) -> bool:
    """该工具调用是否需要用户确认(否则静默放行)。"""
    if tool_name.startswith("mcp__pet__"):
        return tool_name[len("mcp__pet__"):] in SENSITIVE_PET_TOOLS
    return tool_name not in SILENT_TOOLS

TOOL_HINT = """\
你有一组内置工具:
- 感知:list_windows(所有窗口)、focused_window(当前聚焦的单个窗口,最轻)、
  now_playing(正在播放的媒体)、take_screenshot(截屏,看具体画面时才用)、
  read_clipboard(读剪贴板文本)
- 行动:open_url(浏览器开网址)、open_path(默认应用开文件/目录)、notify(桌面通知)
- 展示:show_notepad——较长/结构化内容(终端输出、markdown 文档、代码、表格、
  富文本)用独立记事窗口展示,别硬塞进气泡或读出来。回复里简短点一句即可。
- 家庭服务器(若可用):homelab_status(Jellyfin/相册/下载/追番实时状态)、
  homelab_topology(网络拓扑 + 各服务准确访问地址)。要打开/提及家里某个服务的
  网址时,先查 homelab_topology 拿准确地址,绝不要凭泛域名/子域名自己拼
  (内网服务未必有公网域名,瞎拼会打开错的页面)。
- 记录:write_note/read_notes(替用户记事项)、set_reminder(提醒)、
  remember(记住关于用户的长期事实,悄悄记不必每次提及)
想知道用户在忙什么优先 focused_window / list_windows(快且省),需要看画面内容才截屏。
open_url/open_path/read_clipboard 会请求用户确认,放心大胆用。"""

MEMORY_HINT = """\
你对用户的长期记忆(往次会话沉淀,可信但可能过时):
{memory}"""


def build_system_prompt(card: CharacterCard | None, memory_text: str = "") -> str:
    parts: list[str] = []
    if card is not None:
        parts.append(card.persona)
        if card.tones:
            parts.append(f"可用语气标签: {', '.join(card.tones)}")
        if card.portraits:
            parts.append(f"可用立绘标识: {', '.join(card.portraits)}")
    else:
        parts.append("你是一个友善的桌面助手角色。")
    if memory_text.strip():
        parts.append(MEMORY_HINT.format(memory=memory_text.strip()))
    parts.append(TOOL_HINT)
    parts.append(SEGMENT_FORMAT_INSTRUCTION)
    return "\n\n".join(parts)


class CharacterAgent:
    """一个角色的持续会话。用法:

    async with CharacterAgent(card, cfg) as agent:
        async for seg in agent.chat("你好"):
            ...
    """

    def __init__(
        self,
        card: CharacterCard | None,
        cfg: AgentConfig,
        schedule_reminder: ReminderScheduler | None = None,
        memory: CharacterMemory | None = None,
        permission_handler: PermissionHandler | None = None,
        permissions: PermissionStore | None = None,
        homelab_url: str | None = None,
        show_notepad: Callable[[str, str, str], None] | None = None,
    ):
        server, _allowed = build_pet_server(schedule_reminder, memory, homelab_url, show_notepad)

        async def can_use_tool(tool_name: str, tool_input: dict, _context):
            # 统一权限门径(不用 allowed_tools,避免遮蔽本回调):
            # benign 静默;auto 模式全放行;已"一直允许"的静默;其余问宿主
            if not needs_confirmation(tool_name):
                return PermissionResultAllow()
            if permissions is not None and (permissions.auto or permissions.is_allowed(tool_name)):
                return PermissionResultAllow()
            if permission_handler is None:
                return PermissionResultDeny(message="该工具未经用户授权")
            choice = await permission_handler(tool_name, tool_input)
            if choice == "always":
                if permissions is not None:
                    permissions.allow_forever(tool_name)  # 跨会话持久
                return PermissionResultAllow()
            if choice == "once":
                return PermissionResultAllow()
            return PermissionResultDeny(message="用户拒绝了此操作")

        options = ClaudeAgentOptions(
            system_prompt=build_system_prompt(card, memory.read() if memory else ""),
            model=cfg.model,
            max_turns=cfg.max_turns,
            mcp_servers={"pet": server},
            can_use_tool=can_use_tool,
            max_buffer_size=16 * 1024 * 1024,  # 截图 base64 会超默认 1MB 缓冲
        )
        self._client = ClaudeSDKClient(options=options)
        self.last_usage: dict | None = None  # 上一轮 usage(含 cache_read/creation,诊断用)

    async def __aenter__(self) -> "CharacterAgent":
        await self._client.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self._client.disconnect()

    async def chat(
        self,
        user_text: str,
        image: bytes | None = None,
        image_mime: str = "image/png",
    ) -> AsyncIterator[ReplySegment]:
        """发送一条消息(可附一张图,如框选截图),产出解析后的分段回复。"""
        if image is None:
            await self._client.query(user_text)
        else:
            data = base64.standard_b64encode(image).decode()

            async def _messages():
                yield {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {"type": "base64", "media_type": image_mime, "data": data},
                            },
                            {"type": "text", "text": user_text},
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "default",
                }

            await self._client.query(_messages())
        text_parts: list[str] = []
        async for message in self._client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        text_parts.append(block.text)
            elif isinstance(message, ResultMessage):
                self.last_usage = message.usage
        for segment in parse_segments("".join(text_parts)):
            yield segment
