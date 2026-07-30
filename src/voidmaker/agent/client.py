"""角色化多轮会话:按配置选择 Claude Agent SDK 或 Codex app-server。"""

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
- 展示:show_notepad——较长或结构化内容的专用显示通道;严格按下方「显示通道协议」调用。
- 家庭服务器(若可用):homelab_status(Jellyfin/相册/下载/追番实时状态)、
  homelab_topology(网络拓扑 + 各服务准确访问地址)。要打开/提及家里某个服务的
  网址时,先查 homelab_topology 拿准确地址,绝不要凭泛域名/子域名自己拼
  (内网服务未必有公网域名,瞎拼会打开错的页面)。
- 记录:write_note/read_notes(替用户记事项)、set_reminder(提醒)、
  remember(记住关于用户的长期事实,悄悄记不必每次提及)
想知道用户在忙什么优先 focused_window / list_windows(快且省),需要看画面内容才截屏。
open_url/open_path/read_clipboard 会请求用户确认,放心大胆用。"""

DISPLAY_CHANNEL_INSTRUCTION = """\
【显示通道协议——必须遵守,优先于一般回答习惯】
聊天气泡与日文语音只用于简短对话。预计回答满足以下任一条件时,必须在最终回复前
先调用 show_notepad,不能用聊天气泡中的长文本代替:
1. 需要列举或解释三个及以上相互独立的项目、问题、步骤或案例,无论是否使用列表符号;
2. 包含表格、代码块、日志、命令输出或多级标题;
3. 完整中文正文预计超过 200 字;
4. 用户询问「有哪些/还有哪些/列出/逐项/分别」,或要求整理、对比、汇总多个项目。

禁止为了避开 show_notepad 而把同一份结构化内容拆成多个聊天分段;判定依据是完整回答
包含多少独立项目,不是 Markdown 格式、分段数量或每段长度。

调用 show_notepad 时,把完整、可独立阅读的内容放进 content,按内容选择
markdown、text 或 html。工具成功后,最终回复只能保留一至两个简短的日中对照分段,
例如「詳しくノートにまとめたよ。/ 详细内容整理到记事本里了。」,不得在 ja 或 zh
中重复记事本正文。只有工具不可用或调用失败时,才在气泡里给出简短的日中对照摘要,
并说明记事本未能打开。"""

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
    parts.append(DISPLAY_CHANNEL_INSTRUCTION)
    parts.append(SEGMENT_FORMAT_INSTRUCTION)
    return "\n\n".join(parts)


class ClaudeCharacterAgent:
    """Claude Agent SDK 持续会话。"""

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

    async def __aenter__(self) -> "ClaudeCharacterAgent":
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


class CharacterAgent:
    """按 ``agent.provider`` 创建一个角色持续会话。

    两个后端暴露相同的 async context manager、``chat()`` 和
    ``last_usage`` 接口,因此 CLI 与 Qt worker 无需感知 provider。
    """

    def __new__(
        cls,
        card: CharacterCard | None,
        cfg: AgentConfig,
        schedule_reminder: ReminderScheduler | None = None,
        memory: CharacterMemory | None = None,
        permission_handler: PermissionHandler | None = None,
        permissions: PermissionStore | None = None,
        homelab_url: str | None = None,
        show_notepad: Callable[[str, str, str], None] | None = None,
    ):
        if cfg.provider == "codex":
            from .codex import CodexCharacterAgent

            prompt = build_system_prompt(card, memory.read() if memory else "")
            return CodexCharacterAgent(
                card,
                cfg,
                prompt,
                schedule_reminder,
                memory,
                permission_handler,
                permissions,
                homelab_url,
                show_notepad,
            )
        return ClaudeCharacterAgent(
            card,
            cfg,
            schedule_reminder,
            memory,
            permission_handler,
            permissions,
            homelab_url,
            show_notepad,
        )
