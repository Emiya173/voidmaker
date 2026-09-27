# 七海千秋角色与 3D 接入调查

调查日期：2026-09-27。本文记录资源证据和初步设计；实际实施与验收进展见文末。

## 已确定的方向

- 用户选择 BowlRoll 的「七海千秋_いこ式ver1.0.1」作为 3D 模型，并于 2026-09-27 确认使用已获许可。
- 原 `card.md` 已不再使用，新的角色格式可以完全重构，无需兼容旧卡文件。
- 继续使用 TypeScript Host/domain/contracts/adapters 和 Quickshell；模型推理维持仓库外独立环境。
- 第三方角色资产、参考录音和模型权重不进入 Git。

## Shinsekai：角色资源与 TTS 的核实结果

### 当前仓库和历史版本

检查当前源码完整文件树，提交为 `eacdb707046016618e8a9c300cffd8c2701b32ae`，
GitHub API 返回 `truncated=false`。其中没有 `.char` 或常见 TTS 权重文件
（`.pth`、`.ckpt`、`.onnx`、`.safetensors`）。这说明当前源码没有直接携带这些文件，
不能据此推断项目没有另行分发角色资源。

历史标签 `v1.0.4`（`ea1909efdb8640d357682d6e4d4bb335bebe3052`）包含
[`data/character_templates/nanami.txt`](https://github.com/RachelForster/Shinsekai/blob/ea1909efdb8640d357682d6e4d4bb335bebe3052/data/character_templates/nanami.txt)。
已读取该文件：它是七海千秋的对话输出模板，包含 21 张立绘的情绪映射、JSON 对话结构和输出规则。
它不是完整角色包，也不是语音权重；导入新系统时应重新设计表达规则，避免直接继承旧项目的输出协议。

README 所指的 `v1.0.4/nanami.char` Release 下载地址本次 HEAD 检查返回 404。
当前公开 Release 清单共 18 项，未发现单独的 `.char` 资产。
当前桌面打包脚本也没有将用户 `data/` 角色目录作为常规资源复制；
没有逐一下载并解包所有历史安装包，不能对历史网盘整合包内容作绝对判断。

### 官方资源目录中的七海包

[官方资源索引](https://github.com/RachelForster/Shinsekai-Resource-Update/blob/main/characters.json)
明确列出七海千秋，登记日期为 2026-05-09。

- [下载入口](https://pan.baidu.com/s/1_MDTiJ-1aJPBiveRLuKiHg?pwd=jyk9)，公开提取码 `jyk9`。
- 本次已通过提取码验证并读取 `人物` 目录。
- 实际文件名：`七海千秋.char`。
- 实际文件大小：308,440,628 字节，约 294.2 MiB。
- 用户已下载包体至 `characters/七海千秋.char`，本次已完成实际归档检查。
- SHA-256：`6c520ec087e2764ac40856e154480d320b6e643c8d6e6413e09243dd3377caaf`。

### 本地包体检查结果

共 48 个文件，ZIP CRC 全部通过，归档成员路径未发现绝对路径或父目录越界。

| 内容 | 实际文件/数量 | 检查结果 |
| --- | --- | --- |
| 人设 | `character.yaml` | 含中文背景、性格、说话风格及 21 种情绪映射 |
| GPT 权重 | `models/nanami-e15.ckpt` | 155,313,312 字节；训练元数据标记 `GPT-e15`，使用 `s1v3.ckpt` 作为预训练来源 |
| SoVITS 权重 | `models/nanami_e8_s496.pth` | 172,765,299 字节；文件头 `06` 对应 `v2ProPlus` |
| 参考录音 | `models/nanami.aac_0001620800_0001747840.wav` | 单声道、32 kHz、16-bit PCM，时长 3.97 秒；配置语言 `ja` |
| 立绘 | `sprites/nanami/*.webp`，21 张 | 为 WebP，不能直接交给现有仅接受 PNG 的加载器 |
| 台词音频 | `speech/nanami/nanami_voice_00.wav` 至 `20.wav` | 21 段配套音频 |
| 参考录音副本 | `speech/nanami/ref.wav` | 与 `models/` 中参考录音的 SHA-256 一致 |
| 来源路径清单 | `manifest.json` | 仅供导入定位，不继承其中的来源机器绝对路径 |

两份权重与参考录音的 SHA-256：

```text
nanami-e15.ckpt
ace8a51279af17d080f951ff0e41a119656b820243d2010501e3cf88f037e8df
nanami_e8_s496.pth
cf478eedd5265f0ed071920479dea6f87937e488253cf07cc7fedd90d7b77729
nanami.aac_0001620800_0001747840.wav
72968947005de319c8bd89bcd38a0860ec420c96829a55d38a51029b36e38334
```

资源调查阶段通过 ZIP 与 pickle 指令静态解析元数据，没有执行反序列化对象；后续已在独立环境进行实际推理验证，见文末。
SoVITS 使用 GPT-SoVITS 自定义文件头；本机 `GPT_SoVITS/process_ckpt.py` 明确将 `06` 映射为
`v2ProPlus`，加载时恢复 ZIP 头，因此不能把普通 ZIP 读取器的头部错误误判为权重损坏。
本机推理代码包含 `v2ProPlus` 支持，实际合成验收见文末。

配置中的素材路径采用 Windows 反斜杠，导入时应映射为包内相对路径。
两份权重必须作为同一声音 profile 配置，不能只换参考录音就声称已接入该角色微调模型。

### .char 的真实结构

已读取 [`tools/file_util.py`](https://github.com/RachelForster/Shinsekai/blob/eacdb707046016618e8a9c300cffd8c2701b32ae/tools/file_util.py)
中的 `export_character` 和导入入口。该格式使用 ZIP，导出器会生成：

- `character.yaml`：角色设定、情绪、语言、参考文本、语速等；
- `manifest.json`：来源路径映射，可能包含导出者本机绝对路径，不应原样导入或传播；
- `models/`：存在于导出者机器上的 `gpt_model_path`、`sovits_model_path`、`refer_audio_path` 对应文件；
- `sprites/`：立绘；
- `speech/`：绑定立绘的台词音频。

导出时缺失的模型路径会写为 `null`。本次已直接检查七海包，确认两份权重均实际存在，
并非只根据扩展名或文件大小推测；模型推理可用性仍与归档完整性分开验收。

### TTS 运行环境另行下载

源码中的 [`tts_bundle_manifest.json`](https://github.com/RachelForster/Shinsekai/blob/eacdb707046016618e8a9c300cffd8c2701b32ae/core/model_assets/tts_bundle_manifest.json)
指向独立的 Genie TTS 和 GPT-SoVITS 环境整合包；GPT-SoVITS 包约 8.19 GB，NVIDIA 50 系列包约 8.84 GB。
这些下载项本身不能证明附带七海千秋专用权重，也不应直接替换当前 NixOS/AMD 推理环境。

## BowlRoll：已下载检查，用户已确认使用许可

[作者发布页](https://bowlroll.net/file/315317)。已使用公开下载提示完成下载，文件大小 7,714,077 字节。
ZIP 的 SHA-256：`4164bbfa418f154f5033c0905e02265f1dcf9a621ee2244183ad6575de946e48`。
校验值须以本次实际下载检查结果为准，模型发布者可能更新同一下载地址。

包内有：

- `nanami_ver1.0.1.pmx`；
- `（おまけ）nanamiフード_ver1.0.1.pmx`，戴兜帽版本；
- BMP/PNG 纹理；
- `利用規約(ReadMe).txt`，记录 2026-03-20 更新了模型及条款。

这是 PMX/MMD 模型，不是 GLB 或 VRM。已读取包内说明，其中明确禁止：

> MMD以外での使用

说明进一步列举游戏、VRChat、绘画软件等用途，并禁止再分发和商业用途。
用户于 2026-09-27 明确确认 BowlRoll 模型使用已许可，后续按该确认推进 VoidMaker 接入，
用途许可不再作为前置阻塞。资产保持本地存放；后续转换和渲染记录见文末。

## 新角色格式的拟议设计

完全重构人设和表现配置，不再围绕旧 `card.md` 设计运行时。

| 部分 | 拟议职责 |
| --- | --- |
| 人设 | 身份、性格、语言风格、知识边界和对话示例；与模型输出协议分开 |
| 外观 | 渲染类型、模型入口、默认姿态、镜头、缩放及表情/口型参数映射 |
| 声音 | 本机 TTS 服务的角色 profile ID、参考音频和语言；权重路径由独立服务维护 |
| 演出 | 对话状态到表情/动作的映射、带句段 ID 和时间戳的口型 |
| 来源 | 资产作者、原始链接、版本、哈希和实际许可记录 |

Shinsekai `.char` 可作为导入来源：仅提取允许的配置和素材，不执行包内代码，
不将其旧提示词、绝对路径或通用环境整合包直接作为运行时配置。

PMX 到渲染器的适配可按已确认的用途许可推进。若转换为 GLB，需分别验收骨骼、
表情 morph、材质与头发/裙子物理；不能假定转换会保留完整 MMD 行为。
QML 负责展示与插值，Host/domain 保持角色状态、播放时钟和取消语义；
模型异步加载与口型事件携带角色 revision、generation 和句段 ID，旧结果不得恢复已取消的动画。

## 后续工作入口

导入、转换、渲染与专用 TTS 的首轮实现已完成，证据见下一节。
尚未完成的试听、使用验收、自然姿态、配置工具、故障回退及 Live2D 等工作，
统一维护在 [角色后续待办](CHARACTER_TODO.md)，不再把已实现功能列为下一步。

## 实施与本机验收（2026-09-27）

已实现：

- `pnpm character:import` 安全导入 `.char`，提取第一张立绘、参考录音及配套 GPT/SoVITS 权重。
- `pnpm character:pmx` 将授权的 PMX 转换为 Qt Quick 3D 网格与贴图；22 个材质部分，保留口型/眨眼 morph。
- Host 角色 manifest 增加 `avatar` 和可选 `voice.url`，每个角色可使用独立回环 TTS 服务。
- QML 延迟加载 3D 组件，保持立绘回退；播放 PCM 驱动口型，断连时闭嘴。频繁投影复用网格对象。
- 人设已在本地 `character.json` 中重写，没有延续旧 `card.md` 或 Shinsekai 输出协议。

本机角色安装在 `~/.local/share/voidmaker/characters/chiaki`，原 `.char` 与开发素材仍保留在被忽略的 `characters/` 中。
`voidmaker-tts-chiaki.service` 使用外部 GPT-SoVITS 环境和角色配套权重，监听 `127.0.0.1:9881`。
没有替换默认 9880 服务的权重。正式 Host 和 Shell 已启动并选中 `chiaki`，
Host 返回 `quick3d`、22 个部分、`outputAvailable=true`、待命、空警告列表。

验证结果：

- `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build` 通过。
- 回归 72 项通过，23 项需要单独环境的测试跳过；本轮未运行数据库/Host 崩溃恢复专项与真实 AEC 专项。
- 覆盖角色专用 URL/健康地址隔离、越界及重名资源、转换失败清理、不覆盖已有目录、
  3D 资源缺失回退、忙碌时禁止切换、停止后丢弃晚到的合成结果。
- Wayland/OpenGL 实际渲染已检查：贴图、服装遮挡、口型、断连闭嘴和切回立绘正常。
  修复了把全部材质设为透明混合导致服装/口腔遮挡错误的问题。
- 真实权重合成中文 WAV：32 kHz、单声道、4.92 秒，`/tmp/voidmaker-chiaki-tts.wav`。
- 正常安装路径下，通过应用实际 HTTP 适配器合成日语 WAV：32 kHz、单声道、6.58 秒，
  请求耗时约 5.78 秒，`/tmp/voidmaker-chiaki-japanese.wav`。
- 未开启麦克风，没有把自动化/文件格式验证当作音色听感验收；需要用户试听确认声线和自然度。

当前边界：保留原模型静止姿态，只支持口型、眨眼和整体轻微起伏。
骨骼动作、MMD 物理、音素级口型和 Live2D 渲染器尚未实现。临时离屏软件/Vulkan平台无法用于本机3D验收，
因此使用实际 Wayland 图形后端验证；不是所有 Qt 图形后端都已覆盖。
