from voidmaker.agent.client import needs_confirmation
from voidmaker.agent.tools import build_pet_server
from voidmaker.perception.desktop import (
    format_focused_window,
    format_now_playing,
    format_windows,
)


def test_format_windows_marks_focus_and_titles():
    text = format_windows(
        [
            {"app_id": "kitty", "title": "vim README", "is_focused": True},
            {"app_id": "chromium", "title": "", "is_focused": False},
        ]
    )
    assert "▶ kitty: vim README" in text
    assert "  chromium" in text  # 无标题只显示 app
    assert "chromium:" not in text  # 空标题不带冒号尾巴


def test_format_windows_empty():
    assert "没有" in format_windows([])


def test_format_focused_window():
    assert format_focused_window(None) == "当前没有聚焦的窗口"
    assert format_focused_window({"app_id": "kitty", "title": "vim"}) == "当前聚焦:kitty: vim"
    assert format_focused_window({"app_id": "imv", "title": ""}) == "当前聚焦:imv"


def test_format_now_playing():
    assert format_now_playing(None) == "当前没有在播放的媒体"
    assert format_now_playing({"status": "Stopped", "title": "x"}) == "当前没有在播放的媒体"
    playing = format_now_playing(
        {"status": "Playing", "player": "chromium", "artist": "",
         "title": "某视频", "position": "1:15", "length": "30:32"}
    )
    assert playing.startswith("▶ 某视频")
    assert "chromium" in playing and "1:15/30:32" in playing
    # 带艺术家、暂停
    paused = format_now_playing({"status": "Paused", "title": "歌", "artist": "歌手"})
    assert paused.startswith("⏸ 歌 — 歌手")


def test_all_tools_registered():
    _server, allowed = build_pet_server()
    for name in ("list_windows", "notify", "focused_window", "now_playing",
                 "open_url", "open_path", "read_clipboard"):
        assert f"mcp__pet__{name}" in allowed


def test_needs_confirmation_tiers():
    # benign:pet 非敏感 + 只读内置 → 静默
    for t in ("mcp__pet__list_windows", "mcp__pet__notify", "mcp__pet__take_screenshot",
              "Read", "Glob", "Grep"):
        assert needs_confirmation(t) is False
    # 敏感 pet 工具 + 有副作用内置 + 未知 → 确认
    for t in ("mcp__pet__open_url", "mcp__pet__open_path", "mcp__pet__read_clipboard",
              "Bash", "Write", "Edit", "WebFetch", "SomethingUnknown"):
        assert needs_confirmation(t) is True
