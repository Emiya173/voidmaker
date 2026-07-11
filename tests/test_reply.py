from voidmaker.agent.reply import parse_segments


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
