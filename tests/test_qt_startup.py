"""Qt 启动环境回归测试。"""

import os

import pytest

from voidmaker.ui import app as ui_app


def test_run_app_removes_host_qt_plugins_before_creating_application(monkeypatch):
    for name in ("QT_PLUGIN_PATH", "QT_QPA_PLATFORMTHEME", "QT_STYLE_OVERRIDE"):
        monkeypatch.setenv(name, "/host/qt/plugins" if name == "QT_PLUGIN_PATH" else "kvantum")
    monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")

    class StartupChecked(Exception):
        pass

    class FakeApplication:
        @staticmethod
        def setHighDpiScaleFactorRoundingPolicy(_policy):
            pass

        def __init__(self, _argv):
            for name in ("QT_PLUGIN_PATH", "QT_QPA_PLATFORMTHEME", "QT_STYLE_OVERRIDE"):
                assert name not in os.environ
            assert os.environ["QT_QPA_PLATFORM"] == "offscreen"
            raise StartupChecked

    monkeypatch.setattr(ui_app, "QApplication", FakeApplication)
    with pytest.raises(StartupChecked):
        ui_app.run_app(None)
