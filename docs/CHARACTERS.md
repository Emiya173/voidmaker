# 角色与桌宠视图

## 使用

新应用支持角色选择、角色设定、独立聊天历史/线程、静态立绘、状态差分和基础口型。
Host/UI 协议升级为 **v6**，应同时更新。缺少角色包时仍可使用内置 VoidMaker 和几何占位形象。

角色目录默认为 `$XDG_DATA_HOME/voidmaker/characters`（通常是 `~/.local/share/voidmaker/characters`），
可用 `VOIDMAKER_CHARACTERS_DIR` 指向其他目录。Host 启动时扫描前 32 个子目录；修改配置后重启 Host。
角色配置和立绘、参考音频均在仓库外，不提交角色内容。

1. 为角色创建目录和下面的 `character.json`；将素材放入该目录。
2. 重启 Host 与 Quickshell，在右侧面板顶部选择角色。
3. 左下角显示角色、状态和朗读中的整句字幕。此面板无键盘焦点、鼠标穿透，不占工作区布局。
4. 待命且连续对话关闭时可以切换；录音、生成或播放中先点击停止。
5. 切换后恢复对应角色的历史和 Codex 线程；未发送的输入被清空，避免意外发到另一个角色。

当前角色面板使用 layer-shell 左下锚点；没有为普通窗口加入应用侧坐标/置顶控制。
暂不提供拖拽、托盘显隐、复杂骨骼动画、情绪推断或逐字对齐字幕。

## 配置格式

```json
{
  "version": 1,
  "id": "example",
  "name": "示例角色",
  "persona": "角色身份、表达习惯和背景。",
  "portraits": {
    "idle": "portraits/idle.png",
    "layered": true,
    "listening": "portraits/listening.png",
    "thinking": "portraits/thinking.png",
    "speaking": "portraits/speaking.png",
    "mouthOpen": "portraits/mouth-open.png"
  },
  "voice": {
    "reference": "voice/reference.wav",
    "promptText": "参考音频中实际说出的文字",
    "promptLanguage": "zh",
    "textLanguage": "auto"
  }
}
```

`portraits`、`voice` 均可省略；配置了 `portraits` 时 `idle` 必填，其余图片可选。
省略角色 `voice` 时沿用全局已配置的 TTS。角色 voice 仅覆盖参考音频/文本/语言，
服务地址、超时和模型权重仍由全局配置及独立模型服务管理；不会因选择角色自动加载旧权重或启动 Python。
没有全局 TTS 服务时，配置角色参考音频也不会自动启用朗读。

- `id` 为小写字母/数字/下划线/连字符，最长 64 字符；`default` 保留给内置助手。
- `layered=false`（默认）：各状态图是完整立绘。`layered=true`：始终显示 idle 基础层，其余为同画布差分叠层。
- `mouthOpen` 在实际播放音量超过阈值时显示；否则使用当前状态图/idle。它不是音素级口型。
- 仅接受角色目录内的相对素材路径；越界路径或越界符号链接会被拒绝。
- 立绘目前限 PNG，每张不超过 16 MiB、边长不超过 8192、总像素不超过 2400 万；参考音频上限 32 MiB。
- 单个无效角色跳过并在界面提示；缺失图片回退至默认立绘/占位形象；不会让其他角色无法使用。
- 不加载旧角色包 schema。现有素材可复制到仓库外的新目录并建立此格式的配置，这是一次性配置工作。

## 状态与数据边界

`packages/contracts/src/character.ts` 校验角色 manifest 和 UI 投影；
`packages/adapters/src/characters.ts` 负责受限文件读取与素材路径；
`packages/domain/src/character.ts` 从语音状态和播放 PCM 音量计算状态、图片和口型。
QML 只显示 Host 投影，不自行判断业务轮次或从计时器伪造说话口型。

`CharacterController` 管理异步切换。切换期间拒绝发送/录音和第二次切换；准备或数据库保存失败时保留原角色。
关闭期间的晚到结果不会改变角色或重新发布状态。UI 等新的会话快照到达后才重新开放输入。
工作线程和桌面观察器不使用角色提示，聊天的工具限制保持生效。

迁移 `0004_characters.sql` 新增 `character_sessions` 和 `character_settings`：

- 持久化选择的角色、角色配置版本与 session 的映射；每个 session 保存独立 Codex thread。
- 内置 default 继续使用原单聊天 session，已有历史保留。
- 角色 manifest 经 schema 解析后的内容哈希用作版本；修改设定或 manifest 会创建新的会话映射，避免旧设定污染新线程。
  旧消息仍在数据库，当前尚无历史版本浏览入口；仅替换同一路径的 PNG 不改变配置版本。
- 角色包被移除/变为无效后，重启回到内置助手；旧历史不删除。
- 后续会话层已支持角色内多会话、重命名、搜索、分页和手动长期记忆，见 [会话与记忆](SESSIONS_MEMORY.md)。

## 本轮验证

- 新增角色 schema/路径越界、缺图回退、差分层、参考音频解析、切换并发/失败/关闭及口型取消测试。
- PostgreSQL 实测角色版本历史隔离、默认历史保留；Host 进程测试切换、恢复历史、忙碌时拒绝及重启恢复选择。
- 假 Codex 验证角色指令在新建/恢复线程时传入，执行工具仍禁用。
- `pnpm check` / `pnpm build` 通过；71 项回归通过，含两个独立测试数据库、真实 mpv 空输出和 Quickshell 重连。
  本轮未重跑两个 AEC 原生/虚拟图专项，也未打开真实麦克风。
- 真实 Quickshell 离屏加载本机已有立绘，渲染截图已检查，无组件加载错误。

本机已有的基础立绘与透明表情差分已复制到仓库外的新角色目录；声音先沿用已验收的全局 TTS。
真实服务验收：

- 已启动 Wayland Shell，角色列表无加载警告；选择角色后真实 Codex 正确使用角色名字。
- 实际 TTS/mpv 播放期间收到非零口型投影。初次检测发现会话完成后投影仍停在思考状态，已补会话状态广播并加入 Host 回归。
- 修复后再次播放验证：结束后口型为零、字幕清空、状态待命；Host 重启恢复所选角色。
- 本次沿用全局声音，没有验证独立角色声线或加载旧日语模型权重，也没有开启麦克风。
- 随后重播较长语句，记录到 38 次图片切换，结束后闭嘴并清空字幕。用户对“口型能看到变化、结束后闭嘴/字幕消失/待命”的反馈为 **“都正常”**。
- 角色切换、历史隔离和重启恢复有 Host 进程回归及本机选择/恢复证据；不同素材包和独立角色声线不由本轮覆盖。
