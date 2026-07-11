# VoidMaker 重构计划

(2026-07 制定。参考仓库:~/dev/sakura;ROCm 环境参考:~/dev/michi-ocr)

## 总体判断

对 sakura 是"带参考的重写":其自研 AgentRuntime / ContextOrchestrator / MCP 桥 /
记忆整理 / 工具权限系统由 Claude Agent SDK 取代;真正继承的是角色包格式、
分段双语回复协议、backchannel 数据和"主动感知"产品设计。

## 旧 → 新 对应

| sakura(自研) | VoidMaker(Claude Agent SDK) |
|---|---|
| AgentRuntime tool_calls 循环 | ClaudeSDKClient 持续会话 |
| ToolRegistry + 内置工具 | @tool + create_sdk_mcp_server(进程内 MCP) |
| app/agent/mcp/ 桥接 | SDK 原生 mcp_servers 配置 |
| 工具权限确认面板 | can_use_tool 回调 / PreToolUse hook → Qt 面板 |
| ContextOrchestrator + prompt 模板 | 角色卡系统提示 + skills 渐进加载 |
| 分层记忆 + curator + qdrant/mem0 | 文件记忆 + 记忆整理子 agent(砍掉向量栈) |
| 分段 JSON + 格式修复 | structured output / 宽容解析(agent/reply.py) |

## 阶段

0. **资产盘点**:下载 .char 角色包,对照 character_loader.py 补全 schema;
   保存分段回复协议与 backchannel manifest 规范。✅ 骨架已按此预留
1. **骨架**:flake.nix + uv + src 布局。✅ 已完成
2. **Agent 核心**:CLI 原型(--cli)验证角色卡 → 分段回复;再加自定义工具
   (截图、提醒、笔记、立绘切换)与权限 hook
3. **角色层与 UI**:PySide6 立绘窗口(app-id=voidmaker,niri window-rule 定位)、
   字幕气泡打字机、输入条;backchannel 快速接话(manifest 规则匹配)
4. **语音**:GPT-SoVITS 外置 HTTP 服务。推理/训练当前都在本机 9070XT
   (ROCm 6.4,gfx1201;torch 走 pytorch.org/whl/rocm6.4 索引,见 michi-ocr),
   在 GPT-SoVITS 仓库内进行;VoidMaker 只改 api_url 即可切换推理机器
5. **主动感知**:移植 screen_awareness 策略(间隔/冷却/该不该开口);
   高频观察用 claude-haiku-4-5 预判,值得开口才升级主模型控制成本

## 模型选择

- 对话主模型:claude-opus-4-8(角色扮演 + 工具能力平衡)
- 屏幕观察摘要/开口预判:claude-haiku-4-5(高频低价值调用降本)

## 平台风险与对策

- Wayland 无自定位/置顶 → niri window-rule(open-floating + default-floating-position);
  后续需要点击穿透/锚定时,立绘层单独抽成 gtk-layer-shell 或 QML/Quickshell(dms 系)
- PySide6 wheel 在 NixOS 缺系统库 → flake devShell 提供 LD_LIBRARY_PATH
- 截图:grim(niri screencopy)不行则 xdg-desktop-portal
- GPT-SoVITS on ROCm 若不稳 → distrobox/容器兜底

## 版权注意

sakura 代码 MIT;夜乃桜立绘/语音是水晶社角色二创,不在 MIT 范围。
本项目公开发布时只带角色包格式,不带角色内容。
