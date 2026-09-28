# 角色与桌宠视图

后续功能与验收清单见 [角色后续待办](CHARACTER_TODO.md)。
Blender 几何编辑、零修改往返与正式 Qt 检查台见 [角色修模流程](CHARACTER_EDITING.md)。

## 使用

新应用支持角色选择、角色设定、独立聊天历史/线程、静态立绘、状态差分、Qt Quick 3D 和基础口型。
Host/UI 协议升级为 **v8**，应同时更新。缺少角色包时仍可使用内置 VoidMaker 和几何占位形象。

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

`portraits`、`voice`、`avatar` 均可省略；配置了 `portraits` 时 `idle` 必填，其余图片可选。
省略角色 `voice` 时沿用全局已配置的 TTS。未设置角色 `voice.url` 时仅覆盖参考音频/文本/语言；
设置 `voice.url` 可指向角色专用回环 HTTP TTS 端点，此时不继承全局健康检查地址，
没有全局 TTS 配置也能朗读。权重仍由独立模型服务管理；选择角色不会切换共享服务的权重或启动 Python。
只有参考音频、没有独立 URL 和全局 TTS 时不会启用朗读。

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

## Shinsekai 导入与 PMX 显示（2026-09-27）

进入 `nix develop` 后运行，两个目标目录都必须是新目录：

```sh
pnpm character:import /path/to/character.char /path/to/characters/chiaki chiaki http://127.0.0.1:9881/tts
pnpm character:pmx /path/to/nanami_ver1.0.1.pmx /path/to/characters/chiaki/avatar
# 可选：为具备「左腕」「右腕」骨骼的模型烘焙收臂站姿
pnpm character:pmx /path/to/nanami_ver1.0.1.pmx /path/to/characters/chiaki/avatar-relaxed --pose relaxed
```

导入工具拒绝覆盖、越界 ZIP 路径和重名素材，限制解压文件数及总大小；不会执行 pickle 或包内脚本。
转换工具使用锁定的 MIT `mmd-parser` 和 Nix 中的 Qt `balsam`。原 PMX 及贴图必须放在同一素材树内。
在生成的 `character.json` 中增加：

```json
"avatar": { "kind": "quick3d", "manifest": "avatar/avatar.json" }
```

`avatar.json` 列出经过转换的 `.mesh`、PNG 贴图、颜色、双面材质和镜头尺寸。
2026-09-27 的显示优化保留 PMX 环境色、高光、专用 Toon 阴影贴图、材质描边色/宽度和逐顶点描边权重。
渲染采用柔和前上方光源、原模型色阶和反向外壳描边，贴图开启 mipmap，保留 MSAA 抗锯齿。
透明表情材质单独混合，不让不透明衣物进入透明排序；描边与身体共用相同口型/眨眼权重。
着色器遵循 [Qt CustomMaterial 的颜色与着色接口](https://doc.qt.io/qt-6/qml-qtquick3d-custommaterial.html)，
属于面向桌宠的 MMD 风格近似，不是 MMD/MME 的完整复刻，也没有实时投射阴影。

新的转换会额外生成 `conversion.json`，记录原始 PMX/纹理哈希、转换格式版本、站姿角度、表情名称与丢弃能力。
输出目录仍须是新目录；原始 PMX 和贴图不被修改。旧 `avatar.json` 可继续加载，获得新材质需重新转换。

`--pose original`（默认）保留初始姿态；`--pose relaxed` 将两侧上臂各收拢 38°，
沿骨骼父子关系烘焙蒙皮顶点、法线和表情位移，不在 QML 中运行骨骼逻辑。
缺少唯一的「左腕」「右腕」或骨骼层级无效会拒绝转换。该预设适用于当前七海模型，其他模型需重新检查穿插。
SDEF 采用 BDEF2 权重近似，不求解 IK、附加旋转或物理；这不是运行时骨骼动画支持。

新 manifest 的 `width`/`depth` 用于适配面板宽度，`centerX`/`centerY` 用于居中。
可在 `avatar.json` 中配置 `"framing": {"yaw": -5, "zoom": 1, "targetY": 0}`：
`yaw` 是模型朝向（±45°），`zoom` 是取景倍率（0.5–3），`targetY` 是镜头相对模型中心的高度偏移（身高比例，±0.5）。
例如 `zoom: 2, targetY: 0.26` 可用于上半身特写；放大可能裁切手脚。修改后重启 Host。
保持 `character.json` 的素材入口不变，仅替换 avatar 内容时，不改变角色人设版本/聊天历史映射。

运行时只读取数据与素材，不执行 Balsam 生成的 QML。每个网格前两个顶点 morph：
第 0 个口型「あ」、第 1 个眨眼「まばたき」。其他模型需具备这两个日文命名的顶点表情，或在转换接口中指定名称。
可使用 `--look /path/to/look.json` 加入按原 PMX 材质名配置的外观和可选常态眼睑，例如：

```json
{
  "materials": {
    "模型中的衣服材质名": {
      "tint": [0.9, 0.95, 0.98],
      "saturation": 0.9,
      "contrast": 1.02,
      "shadeStrength": 0.15,
      "textureStrength": 0.03,
      "specularStrength": 0.2,
      "outlineScale": 0.8,
      "outlineColor": [0.1, 0.1, 0.12]
    }
  },
  "restEyes": {"morph": "模型中的眼睑表情名", "weight": 0.2}
}
```

这些字段全部可选；默认不调色、不增加柔和明暗或表面纹理，并保留原描边与高光。
`tint` 为 RGB 乘色；`shadeStrength` 增加形体明暗，`textureStrength` 增加固定在 UV 上的微量哑光纹理，
纹理小于像素时自动淡出。不同材质可独立控制，避免一套参数同时压暗脸部与衣服。
材质名必须唯一匹配，否则拒绝转换；配置只能包含受限数据，不能加载任意着色器。
具体角色的外观配置、参考图和转换结果存放在本地、排除在 Git 外。

`--look` 还支持离线网格细化与替换纹理。以下字段只在转换时使用，不增加运行时 QML 状态：

- `sourceSha256`：可选的原 PMX SHA-256 锁定；角色专用网格调整建议始终填写，指纹不符即拒绝。
- `textures`：原 PMX 中的纹理相对路径到新纹理相对路径的映射，例如
  `{"tex/uv_02.png": "uv-02-refined.png"}`。新文件相对于 **look.json 所在目录**，不得通过符号链接越界；
  原纹理必须存在，未匹配的映射会报错。应维持原 UV 布局，不能直接把立绘当作模型贴图。
- `geometry`：以唯一材质名选择网格；在站姿烘焙后的 PMX 右手坐标中操作，单位与原模型一致。
  `transform` 包含 `pivot`、按 X/Y/Z 顺序的角度 `rotation`、`translation` 和可选均匀 `scale`（默认 1）。
  `brushes` 为局部椭球调整列表，每项包含 `center`、三个正数 `radius`、位移 `offset`；
  `inner` 指定全影响区域占半径比例（默认 0），外侧使用平滑衰减。各笔刷在原坐标计算后相加，再执行整体变换。
  可选 `uvRegion: {min: [u, v], max: [u, v]}` 限定 UV 岛，`edgeScale` 调整局部描边（默认 1）。
  UV 区域应覆盖完整的目标发束/部件，避免把位置选择边界切在连续表面中央。

局部形变同步处理法线与表情终点，检测顶点处的局部翻转/塌陷，并拒绝跨材质共享顶点的修改。
这些校验不代替多视角自相交检查；发饰必须同时核对正面和侧面的贴合，不能只为正面可见而前移。
第三轮头顶程序形变已被用户指出畸变并撤回；后续造型编辑转入 Blender，先做零修改往返，再按发束修改。
完全关闭描边的顶点不绘制重合外壳，避免深度冲突产生斑点。

`restEyes` 可省略；配置时须唯一匹配一个独立顶点表情，转换器将其写入第 2 号 morph。
它用于常态眼睑微调，权重限 0–0.6，运行时权重为 `restEyes × (1 − blink)`，闭眼时不叠加变形。
断连时嘴和眨眼复位，常态眼睑保留。它不是对话情绪推断，也不扩展 Host 业务状态。
转换格式版本 4 的 `conversion.json` 保存完整外观/网格参数、全部表情名称及原/替换纹理 SHA-256，以便复现。
完成转换后也可编辑 `avatar.json` 中各部分的 `style` 和已存在的 `restEyes` 权重，再重启 Host；
不要给只有两个 morph 的旧网格手动添加 `restEyes`，需要通过转换器生成第三个表情。
支持原始/烘焙站姿、口型、自动眨眼及可选六关节待机；另可通过 `motionRig` 导出并播放三个作者骨骼动作，
见 [骨骼动作工作流](CHARACTER_EDITING.md#连续骨骼动作导出与检查)。没有 VMD、刚体、布料物理或球面贴图。
共用 Toon 贴图目前使用程序色阶近似，七海使用的五张专用色阶则全部保留。
不能将本功能等同完整 MMD 播放器或 VRM 导入器。Live2D 渲染器尚未实现，可后续扩展 `avatar.kind`。

Quickshell 必须与 Qt Quick 3D 来自相同 Nix 锁定环境，用 `nix develop --command quickshell --path apps/shell/shell.qml` 启动。
Flake 已提供 Qt QML/插件路径。系统全局 Quickshell 可能使用另一 Qt 版本，不能混用插件路径。
渲染需要图形后端；本机已用 Wayland/OpenGL 验证，纯软件离屏后端不支持 3D。
模块加载失败或 Host 检测到模型/贴图缺失时回退立绘；建议保留 `portraits.idle`。

角色仍使用左下 layer-shell 面板和原有鼠标穿透，不修改 niri 普通窗口规则。
口型完全由现有播放 PCM 投影驱动；停止后归零，UI 断连也立即闭嘴并停止眨眼/起伏。
高频播放状态更新复用现有 3D 委托，不反复创建网格。全局语音设置页仍编辑默认服务，诊断检查当前选中角色的 TTS。

转换器专项回归可在 Nix 环境运行 `VOIDMAKER_PMX_SMOKE=1 pnpm test tests/character-convert.test.ts`。
它动态生成自制三角形 PMX/BMP，实际执行 ffmpeg/Balsam，检查第二组 UV 描边数据、两个 morph、来源记录，
以及坏索引、缺阴影贴图、源指纹不符、替换纹理未匹配/越界的失败清理；不依赖下载角色素材。
`tests/character-sculpt.test.ts` 另覆盖局部影响范围、法线方向、表情终点、发饰旋转和翻转拒绝。

七海千秋服务模板见 [voidmaker-tts-chiaki.service](systemd/voidmaker-tts-chiaki.service)，
`~/.config/voidmaker/tts-chiaki.yaml` 的 `custom` 配置须设为 `version: v2ProPlus`，
并将 `t2s_weights_path`、`vits_weights_path` 指向导入目录内 `voice/gpt.ckpt`、`voice/sovits.pth` 的绝对路径。
BERT、CNHuBERT 路径使用独立 GPT-SoVITS 环境原有预训练文件；AMD 本机使用 `device: cuda`、`is_half: true`。
新服务独占 `127.0.0.1:9881`，原默认服务继续使用 9880。

安装后可在本机 `~/.config/systemd/user/voidmaker-host.service.d/30-chiaki-tts.conf` 添加
`[Unit]` 下的 `Wants=voidmaker-tts-chiaki.service`，再执行 `systemctl --user daemon-reload`。
这样七海服务随 Host 启动，无需让所有部署都安装该角色，也无需修改通用 Host 服务模板。
