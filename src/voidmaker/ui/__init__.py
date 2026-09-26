"""UI 层(PySide6, Wayland)。

- pet_window.py     桌宠主窗口:气泡区 + 立绘 + 输入条(单一顶层窗口,见文件头说明)
- portrait_widget.py 立绘绘制部件(含 VOIDMAKER_UI_TEST 调试帧)
- bubble.py         字幕气泡(打字机效果)
- agent_worker.py   QThread + asyncio 桥接 CharacterAgent
- app.py            应用入口(app-id=voidmaker)

默认界面由 quickshell/shell.qml 呈现,通过 shell_bridge.py 复用后台控制器。
旧 PySide6 窗口保留为 --classic 兼容模式。
"""
