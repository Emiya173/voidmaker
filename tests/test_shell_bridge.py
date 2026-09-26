"""Quickshell 命令桥接的权限与输入边界。"""

from io import BytesIO
from unittest.mock import Mock

from PIL import Image

from voidmaker.ui.shell_bridge import ShellController, create_preview, handle_command


def make_window():
    window = Mock()
    window._input.isEnabled.return_value = True
    window._perm_current = object()
    return window


def test_send_requires_text_and_free_agent():
    window = make_window()
    quit_app = Mock()

    handle_command(window, {"cmd": "send", "text": "  你好  "}, quit_app)
    window._send_text.assert_called_once_with("你好")

    window._send_text.reset_mock()
    window._input.isEnabled.return_value = False
    handle_command(window, {"cmd": "send", "text": "忙时丢弃"}, quit_app)
    handle_command(window, {"cmd": "send", "text": 123}, quit_app)
    window._send_text.assert_not_called()


def test_permission_requires_pending_request_and_valid_choice():
    window = make_window()
    quit_app = Mock()

    handle_command(window, {"cmd": "permission", "choice": "once"}, quit_app)
    window._on_permission_answered.assert_called_once_with("once")

    window._on_permission_answered.reset_mock()
    window._perm_current = None
    handle_command(window, {"cmd": "permission", "choice": "always"}, quit_app)
    handle_command(window, {"cmd": "permission", "choice": "invalid"}, quit_app)
    window._on_permission_answered.assert_not_called()


def test_screenshot_carries_current_draft_and_quit_closes_bridge():
    window = make_window()
    quit_app = Mock()

    handle_command(window, {"cmd": "snip", "text": "这是什么"}, quit_app)
    window.start_snip.assert_called_once_with("这是什么")

    handle_command(window, {"cmd": "quit"}, quit_app)
    quit_app.assert_called_once()


def test_screenshot_preview_is_small_and_readable(tmp_path):
    image = Image.new("RGB", (1200, 800), "red")
    source = BytesIO()
    image.save(source, format="PNG")

    uri = create_preview(source.getvalue(), tmp_path)

    with Image.open(tmp_path / uri.rsplit("/", 1)[-1]) as preview:
        assert preview.format == "JPEG"
        assert preview.width <= 320
        assert preview.height <= 200


def test_busy_screenshot_request_restores_hidden_shell():
    window = make_window()
    window._snip = None
    window._input.isEnabled.return_value = False

    ShellController.start_snip(window, "保留这段输入")

    window._publish.assert_called_once_with({"type": "snip_done", "ok": False})
    window._on_snip_clicked.assert_not_called()


def test_tray_toggle_requests_visibility_instead_of_stage_change():
    window = make_window()

    ShellController.toggle_visible(window)

    window._publish.assert_called_once_with({"type": "visibility"})
