# VoidMaker 开发约定

## 项目定位

桌面角色 AI 助手(NixOS + niri/Wayland),以 ~/dev/sakura(Rvosy/sakura)为参考重写。
继承:角色包格式、分段双语回复协议(ja+zh+tone+portrait)、主动感知的产品设计。
重写:agent 内核用 Claude Agent SDK(不自研 tool_calls 循环),UI 用精简 PySide6。

## 常用命令

- 进入环境:`nix develop`(自动 uv sync + 激活 .venv)
- 运行:`python -m voidmaker --cli`
- 测试:`pytest`
- Lint:`ruff check src tests`

## 硬约束

- 依赖用 uv 管理(pyproject.toml + uv.lock);不要手动 pip install。
- 本仓库不引入 torch/推理框架。GPT-SoVITS 在 ~/dev/gpt-sovits 独立运行,
  只通过 HTTP 调用(voice/client.py)。ROCm 搭建参考 ~/dev/michi-ocr。
- characters/ 下的角色包内容(立绘/语音,二创资产)不入 git。
- Wayland 约束:窗口不能自我定位/置顶。桌宠窗口 app-id 固定 "voidmaker",
  位置由 niri window-rule 管;不要写 move()/置顶 flag 之类的 X11/Windows 思路代码。

## 架构要点

- agent/client.py:CharacterAgent 是唯一的 LLM 入口;自定义工具将来用
  @tool + create_sdk_mcp_server 注册,权限确认用 SDK 的 can_use_tool/hooks。
- agent/reply.py:分段回复协议。解析必须宽容(模型输出坏 JSON 时兜底为单段中文)。
- character/:兼容 sakura 的 character.json;字段以实际 .char 包为准
  (权威解析逻辑:~/dev/sakura/app/config/character_loader.py)。

## 验证要求

改动 Python 代码后运行相关 pytest;涉及 agent 链路时用 `python -m voidmaker --cli`
实际对话验证一轮。
