"""主动感知的开口预判:分层漏斗,尽量便宜。

Tier A(文本,最廉价):看当前聚焦窗口的 app+标题,haiku 纯文本三分类
  SILENT/SPEAK/LOOK。多数空闲周期止步于此,一次无图调用。
Tier B(单屏截图,仅 LOOK 时):只截聚焦显示器(非全屏双屏)喂 haiku 二分类。

一次性 query()(独立会话、用完即弃),截图/文本都不进主会话上下文。
niri 不可用时直接退到 Tier B 全屏截图(旧行为),保证仍能工作。
"""

from __future__ import annotations

import base64

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock, query

from ..perception.desktop import (
    format_focused_window,
    format_now_playing,
    query_focused_window,
    read_now_playing,
)
from ..perception.proactive import PRECHECK_PROMPT, PRECHECK_TEXT_PROMPT
from ..perception.screenshot import capture_focused_window


async def _ask_text(model: str, prompt: str) -> str:
    options = ClaudeAgentOptions(model=model, max_turns=1, allowed_tools=[])
    parts: list[str] = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    parts.append(block.text)
    return "".join(parts).upper()


async def _image_worth_speaking(model: str) -> bool:
    """Tier B:截聚焦窗口(失败自动回退单屏/全屏)→ haiku 图像二分类。"""
    path = await capture_focused_window()
    mime = "image/png" if path.suffix == ".png" else "image/jpeg"
    try:
        image_data = base64.standard_b64encode(path.read_bytes()).decode()
    finally:
        path.unlink(missing_ok=True)

    async def _messages():
        yield {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": image_data,
                        },
                    },
                    {"type": "text", "text": PRECHECK_PROMPT},
                ],
            },
            "parent_tool_use_id": None,
            "session_id": "precheck",
        }

    options = ClaudeAgentOptions(model=model, max_turns=1, allowed_tools=[])
    parts: list[str] = []
    async for message in query(prompt=_messages(), options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    parts.append(block.text)
    return "SPEAK" in "".join(parts).upper()


async def screen_worth_speaking(model: str) -> bool:
    """分层判断是否值得主动开口。多数情况只花一次纯文本调用。"""
    try:
        win = await query_focused_window()
    except Exception:
        win = None  # niri 不可用:退到全屏截图路径

    if win is None:
        return await _image_worth_speaking(model)

    try:
        media = await read_now_playing()
    except Exception:
        media = None
    prompt = PRECHECK_TEXT_PROMPT.format(
        window=format_focused_window(win), media=format_now_playing(media)
    )
    verdict = await _ask_text(model, prompt)
    if "SILENT" in verdict:
        return False
    if "SPEAK" in verdict:
        return True
    # LOOK(或意外输出)→ 截聚焦单屏细看
    return await _image_worth_speaking(model)
