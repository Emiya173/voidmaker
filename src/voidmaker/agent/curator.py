"""记忆整理子 agent:把未消化的聊天历史蒸馏进角色记忆文件。

启动时后台运行(agent/precheck.py 同款一次性 query,独立会话、用完即弃),
本次整理结果下次会话生效——即时性由 remember 工具覆盖,这里只负责沉淀。
"""

from __future__ import annotations

import json

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

from ..storage.history import ChatHistory
from ..storage.memory import CharacterMemory

# 未消化历史少于此字节数不值得动模型
MIN_PENDING_BYTES = 800
# 送给整理模型的历史上限(过长截尾保留最近的)
MAX_PENDING_CHARS = 24_000

CURATOR_PROMPT = """\
你是桌面角色助手的记忆整理器。下面是角色现有的长期记忆,和最近尚未消化的对话记录。
请输出更新后的记忆文件全文(markdown 条目列表,不要任何额外说明):
- 保留仍然有效的旧条目,合并重复,删除已过时或被新信息推翻的
- 从新对话中提取值得长期记住的事实:用户的身份/偏好/习惯、在做的项目、
  重要约定、相处中形成的默契;忽略一次性的闲聊内容
- 每条一行,以"- "开头,可带 [YYYY-MM-DD] 日期;总量控制在 50 行以内

【现有记忆】
{memory}

【未消化的对话记录】
{pending}
"""


def _format_history(lines: list[str]) -> str:
    parts: list[str] = []
    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = rec.get("content")
        if isinstance(content, list):  # assistant 分段数组
            content = " / ".join(seg.get("zh") or seg.get("ja") or "" for seg in content)
        parts.append(f"{rec.get('role', '?')}: {content}")
    return "\n".join(parts)


async def consolidate_memory(
    character_id: str, model: str = "claude-haiku-4-5"
) -> bool:
    """返回是否实际执行了整理。"""
    history = ChatHistory(character_id)
    memory = CharacterMemory(character_id)
    if not history.path.exists():
        return False
    offset = memory.consolidated_offset()
    with history.path.open("rb") as f:
        f.seek(offset)
        pending_bytes = f.read()
        end_offset = f.tell()
    if len(pending_bytes) < MIN_PENDING_BYTES:
        return False
    pending = _format_history(pending_bytes.decode("utf-8", errors="replace").splitlines())
    pending = pending[-MAX_PENDING_CHARS:]

    prompt = CURATOR_PROMPT.format(memory=memory.read() or "(空)", pending=pending)
    options = ClaudeAgentOptions(model=model, max_turns=1, allowed_tools=[])
    text_parts: list[str] = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    text_parts.append(block.text)
    result = "".join(text_parts).strip()
    if not result.startswith("-"):
        return False  # 输出不像记忆列表,放弃本轮(下次重试,偏移不前进)
    memory.replace(result)
    memory.set_consolidated_offset(end_offset)
    return True
