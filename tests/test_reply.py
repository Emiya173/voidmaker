from voidmaker.agent.client import DISPLAY_CHANNEL_INSTRUCTION, build_system_prompt
from voidmaker.agent.reply import SEGMENT_FORMAT_INSTRUCTION, parse_segments


def test_parse_valid_array():
    text = '[{"ja": "……うん。", "zh": "……嗯。", "tone": "中性", "portrait": "站立待机"}]'
    segments = parse_segments(text)
    assert len(segments) == 1
    assert segments[0].ja == "……うん。"
    assert segments[0].zh == "……嗯。"


def test_parse_array_with_surrounding_text():
    text = '好的,输出如下:\n[{"ja": "a", "zh": "b", "tone": "", "portrait": ""}]\n以上'
    segments = parse_segments(text)
    assert len(segments) == 1
    assert segments[0].zh == "b"


def test_parse_fallback_plain_text():
    segments = parse_segments("这不是 JSON")
    assert len(segments) == 1
    assert segments[0].zh == "这不是 JSON"
    assert segments[0].ja == ""


def test_parse_broken_json_falls_back():
    text = '[{"ja": "未闭合"'
    segments = parse_segments(text)
    assert len(segments) == 1
    assert segments[0].zh == text


def test_silence_paths_yield_no_segments():
    # 主动感知的"保持沉默":空数组/空文本/全空分段都不产生气泡
    assert parse_segments("[]") == []
    assert parse_segments("") == []
    assert parse_segments("   ") == []
    assert parse_segments('[{}]') == []
    assert parse_segments('[{"ja": "", "zh": " ", "tone": "中性", "portrait": ""}]') == []


def test_prompt_requires_notepad_for_long_structured_content():
    prompt = build_system_prompt(None)
    assert DISPLAY_CHANNEL_INSTRUCTION in prompt
    assert "三个及以上相互独立" in prompt
    assert "超过 200 字" in prompt
    assert "有哪些/还有哪些" in prompt
    assert "禁止为了避开" in prompt
    assert "最终回复前" in prompt
    assert "不得在 ja 或 zh" in prompt


def test_segment_prompt_requires_spoken_text_and_subtitle_to_match():
    assert "实际送入 TTS" in SEGMENT_FORMAT_INSTRUCTION
    assert "逐段一一对应" in SEGMENT_FORMAT_INSTRUCTION
    assert "信息量必须一致" in SEGMENT_FORMAT_INSTRUCTION
    assert "不能单独增加" in SEGMENT_FORMAT_INSTRUCTION
