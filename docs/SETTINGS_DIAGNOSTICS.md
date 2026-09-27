# 设置、诊断与桌面入口

2026-09-27：协议 **v8**，Host 和 Quickshell 应一起更新。此轮不增加数据库迁移。

## 设置

「设置 → 配置」提供以下常用字段：

- 麦克风与播放设备的 PipeWire `node.name`；运行诊断后可从设备列表选择。
- ASR 的开关、请求地址、模型、语言、超时和可选健康检查地址。
- TTS 的开关、请求地址、参考音频、参考文本、语言、超时和可选健康检查地址。
- VAD 能量阈值、句末等待、最短语音和最长录音。
- 双路采集/AEC 开关、插件目录和连续对话插话开关。

AEC 的细分检测参数从当前配置保留；此页不自动调参。AEC 参考输出必须与播放设备一致。
角色包中的参考声音仍覆盖全局参考音频与语言；角色文件的可视化编辑不在本轮范围。

对话、录音、转写或播报期间不能修改配置。先停止，再点击「保存并应用」，无需重启 Host。
旧语音控制器先取消并释放资源，保存成功后才替换；保存失败仍使用旧配置。启用 ASR/AEC 不会开始录音。
多个界面并发编辑时，旧修订号会被拒绝；未保存的表单保留，需要重新读取再修改。

### 配置文件与恢复

沿用 `VOIDMAKER_VOICE_CONFIG`，缺省为 `$XDG_CONFIG_HOME/voidmaker/voice.json`（通常是 `~/.config/voidmaker/voice.json`）。

- schema 校验后，以同目录临时文件、`fsync`、原子重命名写入；权限 `0600`。
- 保存前保留上一份有效配置为 `voice.json.previous`；「恢复上一份」会交换当前/备份的有效配置。
- 格式或字段无效时，Host 使用未启用语音的配置并显示错误；修正保存时，原始无效内容保存为 `voice.json.invalid-backup`，已有有效备份保留。
- 符号链接可以读取，但界面不覆盖它。Nix 声明式配置可继续管理原文件；若要通过 UI 保存，须选用可写的普通配置文件。
- 文件最多 64 KiB；超大文件、目录、权限等读取错误仍会阻止启动。
- 使用内容哈希检测界面或外部编辑器的版本冲突。不要在保存的同时由外部进程反复改写同一文件；该检查不是跨进程文件锁。
- 「重新读取」放弃本地表单草稿并加载磁盘配置；外部编辑无自动热加载。

请求地址和健康检查地址均限制为本机回环 HTTP/HTTPS，不接受 URL 用户名/密码。
新应用配置采用严格 schema，未知字段会报错，避免保存时静默丢失字段。

## 诊断

「设置 → 诊断 → 检查服务与设备」只检查**已保存**配置。每轮有 5 秒总截止时间，可取消；配置更改会清空旧诊断，迟到结果不会覆盖新状态。

| 项目 | 实际检查 | 未验证的内容 |
| --- | --- | --- |
| PostgreSQL | 有界的 `SELECT 1` | 备份可恢复性、复杂查询性能 |
| Codex | 聊天子进程及输入通道是否在线 | 登录状态、远端模型调用、计费权限 |
| ASR | 默认同源 `/health`，或配置的 `healthUrl`；识别 `ready`，核对可用的模型名称 | 不上传音频、不转写；不验证识别质量 |
| TTS | 默认 GET `/openapi.json`，确认请求路径存在；可指定健康端点 | 不合成音频、不验证模型预热和参考声音 |
| PipeWire | `pw-dump` 元数据及输入/输出节点 | 不打开采集，不验证音质或声学插话效果 |
| 设备选择 | 所指定输入/输出是否在线 | 默认设备的实际路由 |
| AEC | 插件文件是否可访问 | 不加载音频图，不验证回声消除 |
| 托盘 | 会话总线及桌面托盘宿主注册状态 | 实际托盘布局和用户听感 |

界面区分「就绪」「可连接」「未就绪/预热中」「未配置」「异常」。TTS 接口可连接不等于模型已预热；诊断结果不作为自动录音或自动模型请求的授权。

## 托盘与快捷键

Host 用 TypeScript `dbus-next` 导出 StatusNotifierItem 及 `com.canonical.dbusmenu` 菜单；不依赖旧 Python 托盘。
左键切换显隐，右键打开分组菜单：

| 菜单项 | 行为 |
| --- | --- |
| 显示/隐藏 VoidMaker | 同时切换主面板和角色层 |
| 对话 | 显示对话页 |
| 后台任务 | 显示项目、任务进度与审批页 |
| 会话与记忆 | 显示会话管理页，保留上次选中的会话/历史/记忆子页 |
| 桌面感知 | 显示桌面上下文与授权页 |
| 停止当前对话（含语音） | 直接由 Host 停止当前回复、录音、播报与连续监听；不取消后台任务，不改变面板显隐 |
| 设置 | 显示设置的配置子页 |
| 服务诊断 | 显示设置的诊断子页，由用户点击检查按钮启动只读检查 |

菜单读取、展开和悬停均不触发操作，只有菜单项点击才执行。仍保留 `ContextMenu` 直接打开设置的回调。
宿主延迟启动或重启后会重新注册；会话总线本身断开后需重启 Host。无托盘宿主也可使用快捷键。

界面「隐藏」按钮、托盘及以下 IPC 命令会同时控制主面板和角色层。隐藏时发出停止命令，停止语音采集/播报，并将桌面观察的 UI presence 标记为不活跃。后台任务继续运行。

```sh
quickshell --path /absolute/path/to/VoidMaker/apps/shell/shell.qml ipc call voidmaker toggle
quickshell --path /absolute/path/to/VoidMaker/apps/shell/shell.qml ipc call voidmaker showUi
quickshell --path /absolute/path/to/VoidMaker/apps/shell/shell.qml ipc call voidmaker hideUi
quickshell --path /absolute/path/to/VoidMaker/apps/shell/shell.qml ipc call voidmaker settings
```

niri `binds` 示例（替换绝对路径；界面服务须已运行）：

```kdl
binds {
    Mod+V { spawn "quickshell" "--path" "/absolute/path/to/VoidMaker/apps/shell/shell.qml" "ipc" "call" "voidmaker" "toggle"; }
    Mod+Shift+V { spawn "quickshell" "--path" "/absolute/path/to/VoidMaker/apps/shell/shell.qml" "ipc" "call" "voidmaker" "settings"; }
}
```

普通窗口位置仍由 niri 管理；当前两个面板保留 layer-shell 锚点。可用 `VOIDMAKER_TRAY=0` 禁用 Host 托盘注册（隔离测试使用）。

依赖：`dbus-next` 固定版本；可选 `usocket` 原生构建禁用，目标桌面使用文件路径形式的会话总线 socket。
托盘实现参考 [StatusNotifierItem 规范](https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/StatusNotifierItem/)、[Quickshell DBusMenu 接口](https://github.com/quickshell-mirror/quickshell/blob/master/src/dbus/dbusmenu/com.canonical.dbusmenu.xml) 和 [dbus-next 服务接口](https://github.com/dbusjs/node-dbus-next)。

## 验证

- `pnpm check`、`pnpm build` 通过。
- 完整回归 **86 项通过、2 项跳过**；跳过的是另行启用的原生 AEC/虚拟音频链路测试。
- 配置原子写入、备份恢复、无效配置恢复、只读链接拒绝、外部修改冲突、备份失败、忙碌/关闭防护均有覆盖。
- 假健康响应验证 ASR 未就绪、模型不匹配、TTS 仅元数据可连接；取消诊断与过期结果隔离有覆盖。
- 真 Host + 假 Codex + 独立 PostgreSQL 验证保存/恢复即时更新语音能力，全程不录音。
- 真 Quickshell 离屏测试表单及未保存草稿保护；隔离 D-Bus 验证托盘激活、宿主延迟启动与重注册。
- **本机只读验收通过**：原语音配置有效；PostgreSQL 与 ASR 就绪，Codex 进程和 TTS 元数据接口可连接；发现 2 个输入、4 个输出，已配置设备在线。
- **本机显隐链路通过**：`hideUi/showUi` 实际控制界面；通过实际 StatusNotifierItem 的 Activate/ContextMenu 调用验证托盘到 Shell 的显示/隐藏与设置请求。首次验收发现 `show` 与 Quickshell 内置命令冲突，已改名并复测通过。
- 检查前后 VoidMaker 录音流数量均为 0。
- **设置与诊断真人验收通过**：2026-09-27，用户临时增加句末等待、保存、恢复上一份并检查服务与设备后，确认“保存、恢复和诊断都正常”。此项无需录音。
- **桌面入口真人反馈**：2026-09-27，用户最初反馈“都正常”，随后明确反馈托盘右键无功能。此前直接调用 `ContextMenu` 的检查不能代表桌面宿主实际右键交互通过，右键结论以本次复测为准。

## 托盘右键修复（2026-09-27）

- 原实现的 `Menu` 为 `/`，没有导出菜单，只实现了 `ContextMenu` 回调。本机 DMS 优先读取菜单，无菜单时走单独的脚本备用调用；直接调用回调的旧测试没有覆盖这个入口。
- 新实现导出 `/StatusNotifierItem/Menu`，提供静态菜单布局、属性查询、点击事件及菜单显示接口，宿主可直接渲染菜单。
- `pnpm check`、`pnpm build` 与 `VOIDMAKER_TRAY_SMOKE=1 pnpm test tests/tray.test.ts` 通过。隔离 D-Bus 回归覆盖菜单布局/属性、点击、悬停不执行、无效 ID、批量事件与宿主重启后菜单可用。
- 已重启本机 Host。真实 Quickshell `SystemTray` 将 VoidMaker 识别为 `hasMenu=true`，`QsMenuOpener` 读到两个菜单项；触发「设置」后实际 Host 发出显示设置页事件。没有启动麦克风。
- **真人复测通过**：用户实际右键托盘并点击「设置」，确认“菜单出现，设置可以打开”。本轮未重跑全量回归。

## 托盘常用入口扩展（2026-09-27）

- 用声明式菜单数据增加页面入口、停止操作及分隔线。导航事件以目标页面取代原先的设置布尔值，协议升级为 v8；Host 与 Shell 已一起更新，无数据库迁移和 niri 配置变更。
- 「停止当前对话」复用 Host 的停止流程，即使面板隐藏也可执行；菜单项不会开启麦克风或自动提交对话。页面跳转保留未保存的配置输入。
- `pnpm check`、`pnpm build` 通过；托盘 D-Bus、Shell 连接、设置表单、完整 Shell 导航、独立测试库上的 Host 取消/中断恢复回归共 5 项通过。完整 Shell 导航测试使用离屏窗口容器承载真实控件和事件处理，不验证 layer-shell 布局。
- 本机真实 Quickshell 读到 8 个操作项与 3 个分隔线，逐一触发六个页面导航后实际 Host 事件正确；停止操作推进语音取消代次且保持待命，没有开启录音。
- **真人菜单与跳转验收通过**：用户按提示检查分组菜单及页面入口，确认“菜单和跳转都正常”。本次无需录音；此反馈不作为托盘停止操作在真实录音/播报期间的单独验收。

语音稳定性专项继续暂缓。真人语音委托后台任务的完整旅程已通过，见 [后台任务验收](WORK_TASKS.md#真人语音委托验收2026-09-27)。
