# VoidMaker

面向 **NixOS + niri + Quickshell** 的 AI 语音助手，正在从 Python 桌宠全面重构为 TypeScript 应用。
完整目标与选型见 [重构计划](docs/VOICE_ASSISTANT_PLAN.md)。
当前缺口、待验收与暂缓范围见 [整体未完成项](docs/REMAINING_WORK.md)。

## 当前可用范围

- 独立 TypeScript Host，经 Unix socket 连接新的 Quickshell 界面。
- 两级陪伴／沉浸界面、左侧可编辑转写与纯文字回复气泡，见 [使用与实现说明](docs/UI_IMPLEMENTATION.md)。当前 IPC 为 v10，Host 与界面需一起更新。
- 角色配置与切换、按角色隔离的历史/线程、立绘差分与播放音量驱动的基础口型，见 [角色说明](docs/CHARACTERS.md)。
- Codex App Server 文字对话、最终回复流和停止生成；普通聊天只处理提供的上下文。
- PostgreSQL 保存消息与 Codex 线程引用，Host/UI 重启后恢复历史。
- 纯函数对话/语音状态机、协议校验、数据库迁移与回归测试。
- 持久后台任务、项目草稿、审批、取消、产物校验及崩溃恢复，见 [后台任务](docs/WORK_TASKS.md)。
- 桌面窗口 / 媒体读取、手动框选截图、独立到期授权和默认关闭的主动建议，见 [桌面上下文](docs/DESKTOP_CONTEXT.md)。
- PipeWire 录音、可编辑 ASR 转写、GPT-SoVITS 按句朗读、半双工及可选双路插话连续对话与取消控制。

ASR 选用 **Qwen3-ASR-0.6B**，TTS 使用 GPT-SoVITS，均需单独部署本地模型服务。
当前机器已完成本地部署、真人麦克风、单句插话及 Host/UI 连续对话验收；不同声学条件和长期稳定性仍待验证。
服务操作与实测数据见 [部署验收报告](docs/DEPLOYMENT_ACCEPTANCE.md)。
部署、配置和评测见 [语音接入说明](docs/VOICE_SETUP.md)。复杂角色动画和逐字字幕尚未实现。
`src/voidmaker/` 是待迁移/删除的旧 Python 实现；新入口不依赖它，也不保证旧 UI 或配置兼容。

当前每个角色配置版本支持多个聊天会话。对话页加载最近 200 条消息，「会话与记忆」页支持完整历史分页搜索及手动记忆管理。
后台任务审批已持久化；普通聊天禁用执行工具。
聊天 Codex 子进程故障后需重启 Host；聊天事件增量游标及任务历史分页尚未实现。

## 开发环境

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Codex CLI 需单独安装并登录，当前协议验证版本为 `codex-cli 0.156.1`。
本项目使用 `codex app-server` 本地 stdio JSON-RPC；[官方接口说明](https://learn.chatgpt.com/docs/app-server)。

## PostgreSQL

Host 仅使用 PostgreSQL，启动时运行 `db/migrations/` 中尚未应用的 SQL。连接设置使用标准的
`PGHOST`、`PGPORT`、`PGUSER`、`PGDATABASE` 环境变量，或 `DATABASE_URL`。
数据库不可用时启动失败，不会切换到文件数据库。

如已有本机 PostgreSQL，创建专用数据库/角色后配置连接即可。开发时也可启动仅监听用户 Unix socket 的实例：

```sh
mkdir -p "$HOME/.local/state/voidmaker" "$XDG_RUNTIME_DIR/voidmaker-postgres"
initdb -D "$HOME/.local/state/voidmaker/postgres" --auth-local=trust --auth-host=scram-sha-256
pg_ctl -D "$HOME/.local/state/voidmaker/postgres" \
  -l "$HOME/.local/state/voidmaker/postgres.log" \
  -o "-k $XDG_RUNTIME_DIR/voidmaker-postgres -c listen_addresses=''" start
export PGHOST="$XDG_RUNTIME_DIR/voidmaker-postgres"
export PGDATABASE=voidmaker
createdb voidmaker
pnpm db:migrate
```

`initdb` 和 `createdb` 仅首次执行；已有数据目录不要重新初始化。生产使用时应在 NixOS 中声明本机
PostgreSQL 服务、专用数据库角色与备份策略。连接凭据只放用户配置，不提交到仓库。

## 运行

在配置好 PostgreSQL 连接的终端启动 Host：

```sh
pnpm dev:host
# 或 pnpm build 后：
pnpm start:host
```

另一个终端启动 UI：

```sh
quickshell --path apps/shell/shell.qml
```

Host 的 socket 默认在 `$XDG_RUNTIME_DIR/voidmaker/host.sock`，也可通过 `VOIDMAKER_SOCKET` 覆盖。
UI 重载或退出不会停止 Host；最后一个 UI 断开时停止语音并退出连续模式。普通聊天线程使用只读沙箱；需要进一步权限时在 UI 中允许或拒绝。
聊天工作目录为 `$XDG_STATE_HOME/voidmaker/chat`（默认 `~/.local/state/voidmaker/chat`），
避免把应用源码目录作为日常聊天上下文。模型配置读取 `~/.config/voidmaker/config.toml`，见
[配置示例](docs/config.example.toml)：聊天及朗读台词使用 `gpt-6-sol / medium`，主动观察使用 `gpt-6-luna / high`。
引擎使用独立的 `$XDG_STATE_HOME/voidmaker/codex`，仅通过 `auth.json` 链接复用已有登录，
不继承全局 Codex 的配置、角色指令或会话。无文件登录时可用该 `CODEX_HOME` 单独登录。
恢复旧聊天线程失败时，会从 VoidMaker 数据库注入近期记录与已启用记忆，显示历史保留。
全局快捷键和位置由 niri 配置；新面板使用 layer-shell 屏幕锚点。

[systemd 用户服务模板](docs/voidmaker-host.service)可用于常驻运行，安装前需按实际仓库目录调整
`WorkingDirectory`，并在 `~/.config/voidmaker/host.env` 设置数据库连接。模板不会自动安装或启用。

## 验证

```sh
pnpm check
pnpm test
pnpm build
```

数据库集成测试使用专门的测试数据库：

```sh
createdb voidmaker_test
VOIDMAKER_TEST_DATABASE_URL="postgresql:///voidmaker_test?host=$PGHOST" pnpm test
```

未设置 `VOIDMAKER_TEST_DATABASE_URL` 时，数据库测试会跳过。Codex 协议测试使用本地假服务，
不会访问模型或消耗额度；真实 Codex 和 Quickshell 链路另做实机验收。

## 代码组织

```text
apps/host/          TypeScript Host 与数据库迁移入口
apps/shell/         Quickshell/QML 界面
apps/tools/         ASR 同机评测工具
packages/contracts/ UI/Host 协议与 schema
packages/domain/    纯状态转移与领域规则
packages/adapters/  Codex、PostgreSQL 等副作用边界
db/migrations/      PostgreSQL SQL 迁移
tests/*.test.ts     TypeScript 单元/集成测试
```

角色素材、参考音频和模型权重不入库。本地模型服务保持独立环境；Python 仅用于确实需要它的模型推理。

### 会话与记忆

协议 v6 新增「会话与记忆」页：多个会话、归档恢复、历史分页搜索、角色/会话手动记忆。记忆更改会重置模型上下文，本地聊天历史保留。详见 [使用与验证说明](docs/SESSIONS_MEMORY.md)。

### 设置与诊断

协议 v7 新增「设置」页：语音设备、ASR/TTS、端点参数、原子保存/恢复、只读诊断，以及托盘与 niri 快捷键显隐。保存后立即应用；诊断不录音，隐藏会停止语音。详见 [设置与诊断](docs/SETTINGS_DIAGNOSTICS.md)。
