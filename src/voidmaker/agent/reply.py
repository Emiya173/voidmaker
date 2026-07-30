"""分段双语回复协议(继承自 sakura 的设计):
每段 = 日文原文 + 中文字幕 + 语气 + 立绘标识,用于同步驱动字幕、表情切换和 TTS。
"""

from __future__ import annotations

import json
import re

from pydantic import BaseModel


class ReplySegment(BaseModel):
    ja: str = ""
    zh: str = ""
    tone: str = ""
    portrait: str = ""


SEGMENT_FORMAT_INSTRUCTION = """\
你的每次回复必须是一个 JSON 数组,每个元素是一个对话分段:
[{"ja": "日文原文", "zh": "中文字幕", "tone": "语气标签", "portrait": "立绘标识"}]
其中 ja 是实际送入 TTS 播放的日文语音原文,zh 是气泡显示的中文字幕。每个分段必须满足:
- ja 与 zh 逐段一一对应,表达完全相同的事实、数字、限定条件和语气,信息量必须一致;
- zh 只能忠实翻译同段 ja,不能单独增加解释、列表、例子、链接或结论;
- ja 也不能包含 zh 中没有的信息;两种语言使用相同的分段边界和叙述顺序;
- 普通回复的 ja 与 zh 都不能为空,每段保持适合一次语音播放的一至两句短句。
需要沉默时输出空数组 []。tone 与 portrait 从角色卡定义的可用值中选择。
不要输出 JSON 以外的任何文字。"""

_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)


def parse_segments(text: str) -> list[ReplySegment]:
    """宽容解析:优先取文本中第一个 JSON 数组;失败则整段作为单条中文回复。

    空文本/空数组返回 [](主动感知的"保持沉默"路径);全空分段被过滤。
    """
    match = _ARRAY_RE.search(text)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, list):
                segments = [ReplySegment.model_validate(item) for item in data if isinstance(item, dict)]
                return [seg for seg in segments if seg.ja.strip() or seg.zh.strip()]
        except (json.JSONDecodeError, ValueError):
            pass
    stripped = text.strip()
    return [ReplySegment(zh=stripped)] if stripped else []
