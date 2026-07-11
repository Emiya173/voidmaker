# VoidMaker

桌面角色 AI 助手:角色包驱动、主动屏幕感知、Claude Agent SDK 内核。
参考项目:[Rvosy/sakura](https://github.com/Rvosy/sakura)(本地副本 `~/dev/sakura`),
主要继承其角色包格式(`.char` / `character.json`)与分段双语回复协议;agent 内核与 UI 全部重写。

## 快速开始(NixOS)

```sh
nix develop        # 建 venv 并 uv sync,进入后自动激活
python -m voidmaker --cli   # 终端对话原型
pytest             # 跑测试
```

依赖 Claude Code CLI 已登录(Claude Agent SDK 通过它驱动 agent loop)。

## 部署

**前置**:NixOS + niri/Wayland;Claude Code CLI 已登录;可选 GPT-SoVITS(TTS,
见下)、麦克风(语音输入)。可复现性:`flake.lock` 钉死 nixpkgs、`uv.lock` 锁定
Python 依赖,`nix develop` 重建即可(需联网拉 wheel)。

1. **获取与环境**
   ```sh
   git clone <repo-url> voidmaker && cd voidmaker
   nix develop        # 自动 uv sync 到 .venv 并激活
   ```

2. **角色包**:把角色放到 `characters/<id>/`(`character.json` + 立绘/语音)。
   立绘/语音是二创资产,**不入库、需自备**(格式见 `characters/README.md`)。
   没有角色包也能跑,显示占位立绘。

3. **配置(均可选,不建文件用默认值)**:`~/.config/voidmaker/config.yaml`——
   TTS / 语音输入 / 家庭服务器各节见下文对应章节;homelab 拓扑参考放
   `~/.config/voidmaker/homelab.md`(模板 `docs/homelab.example.md`)。
   这些含个人地址/资产的文件都在仓库外,不进 git。

4. **运行**
   ```sh
   python -m voidmaker          # 桌宠 UI(默认)
   python -m voidmaker --cli    # 终端对话
   python -m voidmaker --admin  # 本地管理后台
   ```

5. **niri 集成**:窗口定位靠 window-rule、启停靠快捷键 binds——见下一节。

## niri 配置

桌宠窗口在 Wayland 下不能自我定位/置顶,交给 niri window-rule:

```kdl
window-rule {
    match app-id="voidmaker"
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

注意:此规则需放在任何全局 window-rule 之后(同属性后者覆盖前者)。
调试:`VOIDMAKER_UI_TEST=blank|circle` 可渲染空白帧/红圆测试帧,用于排查透明合成问题。

### 快捷键启/停(不自启)

桌宠不随桌面自启,由快捷键控制,进程常驻——收起时只是隐藏窗口,对话历史与
提示词缓存都保留,再唤出即刻可用。(注:透明区点击穿透在 niri 上不可行——niri
对普通 xdg 窗口只按几何矩形做命中,透明区会激活顶层窗口而非穿透到下层;唯一
能穿透的是 wlr-layer-shell surface,但那需要整套切到 nixpkgs 的 Qt,权衡后未采用。)

在 niri 配置的 `binds { ... }` 里加两个键:

```kdl
binds {
    // 唤出 / 收起(首次按启动;已在运行则切换显隐)
    Mod+Shift+P { spawn "nix" "develop" "--command" "python" "-m" "voidmaker"; }
    // 释放退出(结束进程,下次 Mod+Shift+P 重新启动)
    Mod+Shift+O { spawn "nix" "develop" "--command" "python" "-m" "voidmaker" "--quit"; }
}
```

`spawn` 的工作目录需为本仓库(或把 `python -m voidmaker` 换成绝对路径的
启动脚本)。启动键靠单例检测:已有实例时新进程只发一条切换命令随即退出。

记事窗口(show_notepad 工具弹出的独立信息窗)与桌宠同 app-id,靠 title 前缀区分。
桌宠规则建议收紧为 `match app-id="voidmaker" title="^VoidMaker$"`,并给记事窗单独定位:

```kdl
window-rule {
    match app-id="voidmaker" title="VoidMaker 记事本"
    open-floating true
    default-column-width { proportion 0.5; }
}
```

## TTS(GPT-SoVITS)

推理/训练在独立仓库运行(当前:`~/dev/gpt-sovits`,ROCm/9070XT),
本项目只调其 HTTP API。启动推理服务:

```sh
cd ~/dev/gpt-sovits && nix develop --command \
  python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

在 `~/.config/voidmaker/config.yaml` 配置:

```yaml
tts:
  enabled: true
  api_url: http://127.0.0.1:9880/tts
  params:
    text_lang: ja
    ref_audio_path: /path/to/ref.wav
    prompt_lang: ja
```

将来迁移到其他推理机器时只需改 `api_url`。

## 语音输入与连续对话

语音输入走 pw-record + faster-whisper(CPU int8,懒加载)。两种用法:

- **单次**:点 🎤 开始/结束录音,识别结果填入输入条供确认。
- **连续对话**:右键菜单勾选"语音连续对话"(或 `VOIDMAKER_VOICE_CHAT=1` 启动),
  持续拾音、能量 VAD 自动断句、识别后直接发送;她说话/思考期间自动暂停拾音
  (半双工,防自回授),空闲后恢复。点 🎤(👂)退出该模式。

## 家庭服务器状态(可选)

若在家庭网络内、且部署了 homelab-hub 聚合层,她能查家里服务器的实时状态
(Jellyfin/相册/下载/追番)。在 `~/.config/voidmaker/config.yaml` 配置:

```yaml
homelab:
  enabled: true                          # 不在家里的网络就设 false
  hub_url: http://<你的内网主机>:<端口>   # homelab-hub /rk 端点(只读,无鉴权)
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
├─ agent/        # Claude Agent SDK 封装 + 分段回复协议 + 预判/记忆整理子 agent
├─ backchannel.py# 快速接话:规则分类 + 模板轮换(等待期 filler)
├─ character/    # 角色包加载(兼容 sakura 格式)
├─ perception/   # 截图 / 屏幕感知(grim / portal)
├─ voice/        # GPT-SoVITS HTTP 客户端 + mpv 播放(段内流式)
├─ ui/           # PySide6 桌宠窗口(气泡/立绘/输入条 + 各后台 worker)
└─ storage/      # JSONL 聊天历史 + 跨会话记忆文件
docs/PLAN.md     # 重构计划全文
```
