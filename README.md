# VoidMaker

桌面角色 AI 助手:角色包驱动、主动屏幕感知、Claude Agent SDK / Codex 双后端。
参考项目:[Rvosy/sakura](https://github.com/Rvosy/sakura),
主要继承其角色包格式(`.char` / `character.json`)与分段双语回复协议;agent 内核与 UI 全部重写。

## 快速开始(NixOS)

```sh
nix develop        # 建 venv 并 uv sync,进入后自动激活
python -m voidmaker --cli   # 终端对话原型
pytest             # 跑测试
```

主对话后端可选:

- Claude(默认):Claude Code CLI 已登录,由 Claude Agent SDK 驱动。
- Codex:Codex CLI 已安装并完成 `codex login`,由 `codex app-server` 驱动。

在 `~/.config/voidmaker/config.toml` 切换:

```toml
[agent]
provider = "codex"
model = ""              # 使用 Codex CLI 默认模型;也可填可用的 Codex 模型
reasoning_effort = ""   # 使用 Codex CLI 配置;也可填 low/medium/high/xhigh
auxiliary_model = ""    # 记忆整理使用 CLI 默认模型
```

Codex 后端使用临时 app-server thread、只读命令沙箱和现有权限确认 UI;桌宠内置
工具通过 dynamic tools 接入。需要支持该协议的较新 Codex CLI。

## 部署

以个人桌面环境(NixOS + niri)举例，实际应该没有硬性的发行版要求.

**前置**:NixOS + niri/Wayland;Claude Code CLI 或 Codex CLI 至少一个已登录;可选 GPT-SoVITS(TTS,
见下)、麦克风(语音输入)。可复现性:`flake.lock` 钉死 nixpkgs、`uv.lock` 锁定
Python 依赖,`nix develop` 重建即可(需联网拉 wheel)。

1. **获取与环境**
   ```sh
   git clone https://github.com/Emiya173/voidmaker && cd voidmaker
   nix develop        # 自动 uv sync 到 .venv 并激活
   ```

2. **角色包与图标**:立绘/语音是二创资产,**不入库**(格式见
   `characters/README.md`);没有角色包也能跑,默认界面不会显示占位立绘。
   [Release](https://github.com/Emiya173/voidmaker/releases) 附件提供打包好的
   资产 `voidmaker-assets-<日期>.tar.zst`(含 sakura 角色包 + 立绘版图标,
   附 sha256),一键装好:
   ```sh
   mkdir -p /tmp/voidmaker-assets
   tar --zstd -xf voidmaker-assets-*.tar.zst -C /tmp/voidmaker-assets
   /tmp/voidmaker-assets/install.sh ~/dev/voidmaker   # 参数 = 仓库路径
   ```

3. **配置(均可选,不建文件用默认值)**:`~/.config/voidmaker/config.toml`——
   全部字段带注释的模板见 `docs/config.example.toml`,TTS / 语音输入 / 家庭服务器
   各节另见下文对应章节;homelab 拓扑参考放 `~/.config/voidmaker/homelab.md`
   (模板 `docs/homelab.example.md`)。这些含个人地址/资产的文件都在仓库外,不进 git。

4. **运行**
   ```sh
   python -m voidmaker             # Quickshell 两级桌宠 UI(默认)
   python -m voidmaker --classic   # 旧 PySide6 窗口(兼容模式)
   python -m voidmaker --services  # 先拉起 TTS/STT 服务再启动(见「随桌宠拉起服务」)
   python -m voidmaker --cli       # 终端对话
   python -m voidmaker --admin     # 本地管理后台
   ```

5. **niri 集成**:默认 UI 由 Quickshell layer-shell 固定在右侧,不需要窗口定位规则;
   快捷键 binds 见下一节;
   工作区图标/托盘见「桌面集成」。

## niri 配置

默认界面有两级：第一级只显示固定在右下角的立绘和临时气泡；悬停立绘会出现
「输入 / 截图 / 隐藏」操作。左键立绘或再次运行 `python -m voidmaker` 可展开
第二级侧栏，包含对话、权限确认、语音、截图和记事。`Esc` 或再次点击立绘可
收起侧栏。气泡区域不参与第一级鼠标命中，显示/消失也不改变立绘位置。
右键点击立绘也可在第一级打开简洁输入框，或运行
`python -m voidmaker --compose`；输入后按 Enter 发送，`Esc` 关闭。
一级、二级都可截图；框选时整个界面暂时隐藏，完成后恢复原状态。
点击「隐藏」或运行 `python -m voidmaker --hide` 会隐藏整个界面并保留后台会话；
再次运行 `python -m voidmaker` 会先唤回一级。`--capture` 可从快捷键直接框选。
没有配置角色立绘时不会显示占位立绘。截图缩略图显示在对话消息中。
Quickshell 使用 layer-shell 屏幕锚点，不需要 niri
`window-rule`。如需旧窗口，可运行 `python -m voidmaker --classic`，并为它配置:

```kdl
window-rule {
    match app-id="voidmaker"
    excludes title="VoidMaker 记事本"
    open-floating true
    default-floating-position x=32 y=32 relative-to="bottom-right"
    // 以下覆盖全局装饰(dms 等预设的圆角/阴影/边框会给透明窗口描出实心卡片感)
    draw-border-with-background false
    border { off; }
    focus-ring { off; }
    shadow { off; }
    geometry-corner-radius 0
    clip-to-geometry false
}
```

旧窗口规则需放在任何全局 window-rule 之后(同属性后者覆盖前者)。
调试旧窗口:`VOIDMAKER_UI_TEST=blank|circle` 可渲染空白帧/红圆测试帧。

### 快捷键启/停(不自启)

桌宠不随桌面自启,由快捷键控制,进程常驻。快捷键在一级与二级间切换；立绘
隐藏后再次按键会先唤回一级。对话历史与提示词缓存保留。Quickshell 的输入
区域只覆盖立绘和当前显示的操作控件，气泡消失后上方区域不会拦截桌面点击。

在 niri 配置的 `binds { ... }` 里加两个键:

```kdl
binds {
    // 首次按启动第一级；再次按展开 / 收起第二级
    Mod+Shift+P { spawn "nix" "develop" "--command" "python" "-m" "voidmaker"; }
    // 在第一级直接输入，不展开功能侧栏
    Mod+Shift+Return { spawn "nix" "develop" "--command" "python" "-m" "voidmaker" "--compose"; }
    // 任何状态下隐藏界面，下一次 Mod+Shift+P 唤回一级
    Mod+Shift+H { spawn "nix" "develop" "--command" "python" "-m" "voidmaker" "--hide"; }
    // 从一级或二级直接进入框选
    Mod+Shift+S { spawn "nix" "develop" "--command" "python" "-m" "voidmaker" "--capture"; }
    // 释放退出(结束进程,下次 Mod+Shift+P 重新启动)
    Mod+Shift+O { spawn "nix" "develop" "--command" "python" "-m" "voidmaker" "--quit"; }
}
```

`spawn` 的工作目录需为本仓库(或把 `python -m voidmaker` 换成绝对路径的
启动脚本)。启动键靠单例检测:已有实例时新进程只发一条切换命令随即退出。

默认界面的 `show_notepad` 在侧栏「记事」页显示。旧窗口模式仍使用独立信息窗，
如需单独定位可配置:

```kdl
window-rule {
    match app-id="voidmaker" title="VoidMaker 记事本"
    open-floating true
    default-column-width { proportion 0.5; }
}
```

## 桌面集成(工作区图标与系统托盘)

Wayland 下窗口图标由桌面按 app-id(`voidmaker`)解析同名 desktop entry 得到,
装一次即可让 niri overview / 任务切换器显示图标:

```sh
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp src/voidmaker/assets/voidmaker.svg ~/.local/share/icons/hicolor/scalable/apps/
cp docs/voidmaker.desktop ~/.local/share/applications/   # Exec 按注释改成自己的启动方式
```

想用自定义图标(如角色立绘版):PNG 放 `src/voidmaker/assets/voidmaker.png`
(窗口/启动器)和 `src/voidmaker/assets/tray/<尺寸>.png`(托盘,16-32px 各档),
存在即优先于内置 SVG;主题侧把各尺寸装进
`~/.local/share/icons/hicolor/<尺寸>x<尺寸>/apps/voidmaker.png`。二创图片不入 git。

系统托盘(StatusNotifier)随桌宠自动出现:左键单击切换界面显隐,右键菜单含
显隐/自动允许工具/主动闲聊/语音连续对话/退出;主动闲聊开关会立即生效并写回配置。
需要 bar 提供托盘宿主(dms、waybar 的
`tray` 模块等);没有宿主时自动跳过,仅打一行日志。

## TTS(GPT-SoVITS)

推理/训练在独立仓库运行(当前:`~/dev/gpt-sovits`,ROCm/9070XT),
本项目只调其 HTTP API。启动推理服务:

```sh
cd ~/dev/gpt-sovits && nix develop --command \
  python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

在 `~/.config/voidmaker/config.toml` 配置:

```toml
[tts]
enabled = true
api_url = "http://127.0.0.1:9880/tts"

[tts.params]
text_lang = "ja"
ref_audio_path = "/path/to/ref.wav"
prompt_lang = "ja"
```

将来迁移到其他推理机器时只需改 `api_url`。

## 语音输入与连续对话

语音输入走 pw-record + faster-whisper(CPU int8,懒加载),开箱即用、零配置。
两种用法:

- **单次**:点 🎤 开始/结束录音,识别结果填入输入条供确认。
- **连续对话**:右键菜单勾选"语音连续对话"(或 `VOIDMAKER_VOICE_CHAT=1` 启动),
  持续拾音、能量 VAD 自动断句、识别后直接发送;她说话/思考期间自动暂停拾音
  (半双工,防自回授),空闲后恢复。点 🎤(👂)退出该模式。

### 可选:whisper.cpp GPU 服务

与 TTS 同一模式:转写服务独立运行,本项目只发 HTTP。faster-whisper 的 GPU 端
只支持 CUDA,AMD 卡走 whisper.cpp 的 Vulkan 后端(nixpkgs 包
`whisper-cpp.override { vulkanSupport = true; }`,经 RADV 不依赖 ROCm),
能跑更大的模型换更高的中文准确率(实测 RX 9070 + large-v3-turbo,
十几秒音频 0.2s 出结果,约为 CPU small 的 10 倍)。

```sh
whisper-server -m models/ggml-large-v3-turbo-q5_0.bin --host 127.0.0.1 --port 9881
```

```toml
[stt]
server_url = "http://127.0.0.1:9881"   # 不设或服务不在线 → 自动回退进程内 CPU 转写
```

### 可选:随桌宠拉起服务

懒得手动开两个服务的话,给 TTS/STT 配上启动命令,用 `--services` 启动:

```toml
[tts]
start_command = "cd ~/dev/gpt-sovits && nix develop --command python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml"

[stt]
start_command = "cd ~/dev/whisper-cpp && nix develop -c ./serve.sh"
```

```sh
python -m voidmaker --services   # 探测端口,没在线的才拉起;拉起后不等就绪
```

服务 detached 运行、退出桌宠不回收(冷启动贵,留给下次);预热期间 TTS 静默、
STT 走 CPU 回退。服务日志在 `~/.local/state/voidmaker/<name>-server.log`。

## 家庭服务器状态(可选)

若在家庭网络内、且部署了 homelab-hub 聚合层,她能查家里服务器的实时状态
(Jellyfin/相册/下载/追番)。在 `~/.config/voidmaker/config.toml` 配置:

```toml
[homelab]
enabled = true                            # 不在家里的网络就设 false
hub_url = "http://<你的内网主机>:<端口>"   # homelab-hub /rk 端点(只读,无鉴权)
```

拓扑参考(角色回答「家里网络怎么连的/某服务网址」用)放本地文件
`~/.config/voidmaker/homelab.md`,格式见 `docs/homelab.example.md`。内网地址/
服务清单属个人基础设施信息,不入代码库。

连不上时工具优雅降级(回"暂时连不上"),不影响其他功能。只读,不做任何控制;
密码库等敏感服务不接入。

## 管理后台

浏览器里查/改设置、看聊天日志、查/编辑记忆与权限,不必翻文件或走对话:

```sh
python -m voidmaker --admin     # 打开 http://127.0.0.1:8760
# VOIDMAKER_ADMIN_ADDR=127.0.0.1:9000 可改地址
```

标准库 http.server 实现(零依赖),**只绑 127.0.0.1**——能改配置/记忆/权限属敏感
操作,不暴露到网络。设置保存前用 pydantic 校验;改配置需重启桌宠生效。

## 角色包

`characters/<id>/character.json` + 立绘资源。立绘/语音为二创资产,**不入 git**
(见 .gitignore),仓库只保留格式文档与加载器。从 sakura Release 下载 `.char`
后解压到 `characters/` 即可。

## 项目结构

```
src/voidmaker/
├─ agent/        # Claude/Codex 后端 + 分段回复协议 + 预判/记忆整理子 agent
├─ backchannel.py# 快速接话:规则分类 + 模板轮换(等待期 filler)
├─ character/    # 角色包加载(兼容 sakura 格式)
├─ perception/   # 截图 / 屏幕感知(grim / portal)
├─ voice/        # GPT-SoVITS HTTP 客户端 + mpv 播放(段内流式)
├─ ui/           # Quickshell 界面、PySide6 桥接与旧桌宠窗口
└─ storage/      # JSONL 聊天历史 + 跨会话记忆文件
docs/PLAN.md     # 重构计划全文
```
