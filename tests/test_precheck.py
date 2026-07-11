"""主动感知分层漏斗的分流逻辑(monkeypatch 各层,不触发真实模型/截图)。"""

import voidmaker.agent.precheck as precheck


async def _run(monkeypatch, *, win, verdict, image_result=False):
    calls = {"text": 0, "image": 0}

    async def fake_query_focused_window():
        return win

    async def fake_ask_text(model, prompt):
        calls["text"] += 1
        return verdict

    async def fake_image(model):
        calls["image"] += 1
        return image_result

    monkeypatch.setattr(precheck, "query_focused_window", fake_query_focused_window)
    monkeypatch.setattr(precheck, "_ask_text", fake_ask_text)
    monkeypatch.setattr(precheck, "_image_worth_speaking", fake_image)
    result = await precheck.screen_worth_speaking("m")
    return result, calls


async def test_silent_stops_at_text(monkeypatch):
    result, calls = await _run(monkeypatch, win={"app_id": "mpv"}, verdict="SILENT")
    assert result is False
    assert calls == {"text": 1, "image": 0}  # 未截图


async def test_speak_from_text_skips_image(monkeypatch):
    result, calls = await _run(monkeypatch, win={"app_id": "kitty"}, verdict="SPEAK")
    assert result is True
    assert calls["image"] == 0  # 标题足够确信,不截图


async def test_look_escalates_to_image(monkeypatch):
    result, calls = await _run(
        monkeypatch, win={"app_id": "code"}, verdict="LOOK", image_result=True
    )
    assert result is True
    assert calls == {"text": 1, "image": 1}


async def test_no_window_falls_back_to_image(monkeypatch):
    result, calls = await _run(monkeypatch, win=None, verdict="unused", image_result=False)
    assert result is False
    assert calls == {"text": 0, "image": 1}  # niri 不可用:跳过文本层直接截图
