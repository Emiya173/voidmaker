# 本地语音接入与验收

## 当前状态

TypeScript 已实现 PipeWire 采集、能量端点检测、HTTP ASR、GPT-SoVITS 合成、mpv 播放、
可编辑转写、半双工连续对话、统一停止和播放进度事件。现已增加默认关闭的原生 AEC、持续音频会话和
声学打断候选，配置及验收边界见 [AEC 实现说明](AEC_IMPLEMENTATION.md)。语音配置缺省时，Host 仍可用于文字对话。

当前机器已部署 ASR、TTS、PostgreSQL、Host 与 Quickshell 用户服务，完成现有音频的真实模型与播放验收。
结果与操作命令见 [部署验收报告](DEPLOYMENT_ACCEPTANCE.md)。后续真人录音与临时 AEC 对照结果见
[麦克风与 AEC 验收](MICROPHONE_AEC_ACCEPTANCE.md)，专名识别仍存在错误。
用户已选定 **Qwen3-ASR-0.6B** 为当前 ASR 模型。后续评测用于验证它在目标机器上的质量、延迟和资源占用。

常用配置现可在「设置」页保存与恢复，见 [设置与诊断](SETTINGS_DIAGNOSTICS.md)。

## 1. 准备独立模型服务

模型服务及其 Python/原生依赖、权重放在独立目录/环境，不安装进 VoidMaker 的 Node 环境。
当前客户端只接受本机回环 HTTP/HTTPS 地址，不会自动下载权重、启动模型或转发至云端。

### ASR

当前实机采用独立的 `~/dev/qwen3-asr-service`，以 Transformers/ROCm 实现下面的 HTTP 契约。
依赖由该目录的 `flake.lock` / `uv.lock` 锁定，运行时加载固定模型快照；`/health` 可检查状态。
下面的 vLLM 命令保留为后续流式部署参考，不是本次正在运行的后端。

当前契约是非流式 `POST /v1/audio/transcriptions`：

- `multipart/form-data`：`file` 为 WAV，`model` 为模型服务识别的模型 ID，`response_format=json`；
  可选 `language` 由服务解释。
- 返回 `{ "text": "识别结果" }`。响应必须为字符串，最多 10,000 字符。
- 录音是 16 kHz、单声道、PCM s16 WAV；请求有超时、取消与响应大小限制。
- SenseVoice 特殊标签会从展示转写中移除；不会把标签当作普通对话文本。

[Qwen3-ASR 官方说明](https://github.com/QwenLM/Qwen3-ASR#deployment-with-vllm)列出了 vLLM
的 transcription API。先在独立环境安装支持该模型的 vLLM 版本，记录环境锁文件与模型 revision，
然后可按以下形式启动：

```sh
vllm serve Qwen/Qwen3-ASR-0.6B --host 127.0.0.1 --port 8000
```

这是服务启动接口示例；**不是已经验证的 NixOS/AMD 安装配方**。目标机使用 AMD Navi 48，
必须先依据 [vLLM GPU 安装说明](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)
核对 GPU、ROCm、框架版本和所需算子。当前没有验证这些组合，不直接套用 NVIDIA/CUDA 镜像。

Paraformer 与 SenseVoice 仅保留为后续可选研究，不作为当前部署或验收前置条件。其原生服务协议不一定是上述接口，需在独立模型环境中
提供此 HTTP 契约，或后续新增明确的原生协议适配器；**不能只改 model 字段就假定它们已能运行**。
SenseVoice 还可考察 [sherpa-onnx 原生运行时](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)，
以评估不用 Python 的 CPU 路线。

### TTS

接入 [GPT-SoVITS api_v2](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)。
在已安装依赖、模型及配置的 GPT-SoVITS 目录内启动：

```sh
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

以上是固定权重的原生接口。使用共享服务切换角色权重时，独立推理环境需安装 `voidmaker_api.py` 扩展，
同一锁定环境中以 `python voidmaker_api.py -a 127.0.0.1 -p 9880 -c ~/.config/voidmaker/tts-infer.yaml` 启动。
扩展运行在单进程内，共享 BERT / CNHuBERT；加载新角色前释放旧 GPT / SoVITS 和声码器，清理参考缓存。
只在两个权重加载成功后持久化配置；部分失败时禁止使用不完整权重合成，下一次请求可以重新加载恢复。

全局 `tts.model` 格式为 `{"gptWeightsPath":"/absolute/default.ckpt","sovitsWeightsPath":"/absolute/default.pth"}`。
启用后所有角色共用全局 TTS URL；角色包可以用 `voice.model` 覆盖权重，路径必须在包内。
没有专用权重的角色回到全局默认模型，设置页保存时保留该配置。
扩展 HTTP 契约：

- `POST /model` 接受 `{"model":{...}}`，完成整对加载后返回 `{"ready":true,"model":{...}}`；加载失败返回 503。
- `POST /tts` 在原有字段之外要求 `model`，将选模型和非流式合成串行执行；不接受流式请求。
- `GET /health` / `GET /model` 返回当前就绪状态和权重；部分加载失败返回 503。
- 原生的两个独立换权重接口不在扩展中开放，避免绕过串行切换与缓存清理。

Host 切换角色时预加载；首次启动保留独立文字交互能力，不等待冷启动模型。
每次合成都重申目标权重，无需依赖 Host 的缓存，也能应对推理服务重启。
取消会丢弃旧轮次结果，已经进入 GPU 的计算可能继续到结束；此期间服务不会并行更换权重。

需准备有权使用的参考录音、准确转写和语言；`refAudioPath` 必须是**服务端可读取的绝对路径**。

客户端按句发送 `/tts`，指定 `media_type=wav`、`streaming_mode=false`，校验 PCM 16-bit WAV 后播放。
对话模型在同一轮返回中文字幕、日语台词、语气参考和立绘 ID，省去一次额外翻译请求。
使用 `config.toml` 的对话模型；`[speech].language = "ja"`。仅将校验过的中文字幕显示和存入历史，
不向界面透传协议 JSON、日语台词或内部标签。格式不合法时停止该轮，不播放未校验内容。
整轮校验完成后开始朗读，播放当前句时预合成下一句；队列最多提前一段，取消或插话后丢弃。
合成参数沿用此前夜乃樱应用的 `cut1`、`top_k=15`、`top_p=1`、`temperature=1`、`repetition_penalty=1.2`。
未实现 LLM 生成期间的正式回复提前朗读或流式 TTS。

角色包 `voice.references` 可提供 `id`、`description`、`reference`（包内 WAV 相对路径）、
`promptText`（录音的准确台词）、`promptLanguage`。`neutral` 保留为默认录音，未知 ID 拒绝合成。
语气由上下文和台词意图选择，不改变服务端权重。参考音频须符合 GPT-SoVITS 的时长约束，
没有合适参考时使用默认音色；实际语气与自然度需听音验收。

`voice.waitingClips` 可配置 `{ "audio": "voice/waiting.wav", "subtitle": "嗯……" }`。
它是直接播放的角色短应答，不用于 TTS 参考、不进入对话历史，也不触发模型请求。只接受 0.2–5 秒的
PCM 16-bit WAV。每个文件只放一条完整短语，素材池只收中性迟疑、思考短音，避免随机播放道歉、赞同或拒绝等实质回应。
等待 2 秒后从池中随机播放一条；有多个片段时不连续重复同一录音，每轮最多一次，轮次间冷却 30 秒。
首段字幕到达、正式回复开始、停止、断开或
关闭语音输出均会跳过或中止过渡音。已有连续 AEC 会话可用插话中断过渡音和模型；文字交互不会为此打开麦克风。

`voice.replyClips` 用于有明确含义的句首原声，例如：

```json
{ "id": "apology", "description": "为自己的错误道歉", "audio": "voice/apology.wav", "text": "ごめんなさい。", "subtitle": "对不起。" }
```

每条包含准确的原文、中文字幕和适用语境，接受 0.2–5 秒的本地 PCM 16-bit WAV。缺失、越界、重复 ID 或保留 ID `none` 会被跳过。
对话模型在同一次回复的 `openingClipId` 中选择一个已加载 ID，或选择 `none`；后续 `segments` 只写接续内容，避免重复。
校验后直接播放对应录音，同时预合成后续台词；原声的固定中文字幕会显示并进入历史。原声也支持停止和连续会话插话打断。
模型只负责是否选用，不重新合成这些短句；随机等待音与正式句首原声分别配置。

## 2. 配置应用

编辑仓库外的 `~/.config/voidmaker/voice.json`，结构参见 [配置示例](voice.example.json)。
`XDG_CONFIG_HOME` 可改变配置根目录，也可通过 `VOIDMAKER_VOICE_CONFIG` 指定文件。
修改后重启 Host。配置文件不存在时禁用语音；显式指定的文件不存在或格式错误时启动报错。

`asr` 和 `tts` 均可独立省略：只配置 ASR 可转写后看文字回复，只配置 TTS 可朗读文字对话回复。
配置 `asr.url` 后，省略 `asr.model` 时默认使用 `Qwen/Qwen3-ASR-0.6B`；未配置 ASR 时仍保持禁用。
服务地址的协议、回环主机、超时与参数通过 Zod 校验；拒绝标为 Whisper 的模型配置，无自动回退。
示例录音路径和文本必须替换，不能直接作为可用角色配置。

### 麦克风

```sh
wpctl status
# 查看某个输入节点的 node.name / object.serial：
wpctl inspect INPUT_NODE_ID
```

默认使用 PipeWire 自动选择的输入。需要固定输入时，将 `node.name` 或有效 serial 写入顶层
`"inputTarget": "实际输入节点名称"`。设备重新接入后 serial 可能改变，优先使用 node.name。

USB 麦克风已上线并配置为输入，已完成界面单次模式的真人混合句初测。
可在界面点击“开始说话”继续录制；当前小样本结果不能代替完整 VAD 与声学验收。

## 3. 使用流程

1. 按 README 启动 PostgreSQL、Host 和 Quickshell，再启动所需模型服务。
2. 点击“开始说话”；检测到语音后的约 800 ms 静音会结束录音，也可点击“结束说话”。
3. 单次模式：转写进入输入框，允许更正，确认后发送。
4. 连续模式：点击立绘下方麦克风右侧的循环箭头，直接开启；再次点击关闭，无需展开文字卡或另点麦克风。
   展开页输入框下方的循环箭头操作相同，高亮跟随后台实际状态。开启前须处理未发送草稿、转写和附件。
   转写自动发送；默认半双工路径在模型回复和播放期间关闭麦克风，结束后再次拾音。
   显式配置 AEC 后，整个连续会话保持拾音；开启 `aec.bargeIn` 后允许插话停止播报。
5. “停止”会丢弃当前录音/转写、打断 Codex、取消 HTTP 请求、结束播放器和待朗读句段，并退出连续模式。

录音最多 30 秒（可配置，最高 60 秒），无设备输出、静音不足以形成语音或服务不可用会给出错误并回到待命。
VAD 当前为可调能量阈值，不能可靠区分键盘声、音乐和人声；尚未接入神经 VAD。
AEC 和声学插话已实现为可选路径；直接使用新插件处理后的语音仍有双讲含糊和回声残留，默认不启用。
随后新增双路保护：原始麦克风送 ASR，AEC 仅辅助判断插话，保留原始缓冲以衔接播放停止后的识别。
新双路实机诊断已触发停止播报并得到用户确认，但默认 800 ms 端点等待截断了逗号后的长停顿。
`vad.silenceMs=1000` 的下一轮实机保住了后半句，但插话检测较晚，600 ms 预留丢失开头。
现将原始预留扩大到 1500 ms，配合 1000 ms 句末等待，后续单句真人补测已确认打断及时、整句清楚且识别正确。
该等待比默认通常增加约 200 ms。本机已启用此配置，Host/UI 连续对话的插话、新轮次回复和停止清理已通过交互验收；
不同声学条件和长时间误触发仍待验证，
详见 [麦克风验收记录](MICROPHONE_AEC_ACCEPTANCE.md)。
`pnpm aec:smoke` 仅用于有人值守的临时 PipeWire AEC 对照录音，不会自动改变应用音频路由。
最后一个 UI 连接断开时停止语音并关闭连续模式；手动分开启动的文字 Host 保持运行。
systemd 部署使用 `voidmaker.target` 管理完整生命周期，退出应用后停止 ASR、TTS、Host、Shell 和私有数据库，释放推理进程占用的显存。
UI 热重载和显隐不停止服务组，重连不会自动开启麦克风。
显隐保留已开启的录音、播报和连续模式；隐藏期间仍可语音交互，重新显示不会重新开始或取消当前轮次。明确停止、锁屏、最后一个 UI 连接断开或完整退出才结束采集。

录音只保存在内存。播放 WAV 暂存于 `$XDG_RUNTIME_DIR` 下随机创建的私有目录，正常完成、失败、
取消均删除。主机被 SIGKILL/断电时无法运行清理，残留由 runtime 目录生命周期清理。
取消 HTTP 会停止客户端等待与播放；外部模型是否立即停止计算，取决于模型服务的取消实现。

播放进度取自 mpv `time-pos`，音量事件按该位置采样 WAV PCM RMS；提供句级字幕和进度条。
该进度不是声卡硬件时间戳，RMS 不是实际扬声器响度；角色口型动画和逐字字幕尚未实现。

## 4. 同机 ASR 评测

先在仓库外准备 WAV 录音及正确转写，覆盖普通话、中英日混说、专名、远场、键盘声、回声和静音。
下面是 manifest 格式，音频路径相对 manifest 所在目录；示例不含实际录音：

```json
{
  "cases": [
    { "id": "mixed-01", "audio": "mixed-01.wav", "reference": "打开 VoidMaker 项目", "keywords": ["VoidMaker"] },
    { "id": "silence-01", "audio": "silence-01.wav", "reference": "", "keywords": [] }
  ]
}
```

对已部署的 Qwen3-ASR-0.6B 执行评测；后续比较其他模型时复用同一录音集：

```sh
pnpm asr:evaluate --manifest /path/corpus.json --config /path/qwen-voice.json \
  --output /path/qwen-report.json --warmup
```

工具顺序请求，输出 CER、专名召回率、每条耗时/RTF、P50/P95 耗时、失败率及静音幻觉数。
CER 使用 NFKC、小写并移除标点/空白后的 Unicode 字符编辑距离；不会自动转换繁简体。
空参考文本不计入 CER 分母，单独计静音幻觉；失败条目不伪造转写，CER 仅覆盖成功且参考非空的条目，
必须连同失败率阅读。`--warmup` 使用第一条样本预热一次，不计入统计。

这测的是完整录音请求到最终转写的时间，**未测**流式首字、VAD 句末延迟、显存、RSS 和听感。
报告将这些项列为 `unmeasured`。每份报告只写入新文件、权限 0600，包含录音对应文本，勿提交仓库。
模型版本、服务版本、硬件和运行参数另行记录；没有同机数据前不排名，不指定质量优胜模型。

## 5. 工程验证

```sh
pnpm check
pnpm test
pnpm build
# 实际 mpv，音频输出为 null，不会开启麦克风或扬声器：
VOIDMAKER_AUDIO_SMOKE=1 pnpm test tests/audio-process.test.ts
```

自动测试覆盖 ASR/TTS 请求契约、超时/异常、取消后的迟到结果、连续模式、PCM/WAV、VAD、录音子进程回收、
播放临时文件清理和 CER。假 HTTP 服务只能证明协议与控制流程，不能证明模型识别率或合成质量。

已有音频到真实播放的验收结果见部署报告。后续真人验收：录制评测集并验证指标 → 语音提问并听到回答 →
在录音/ASR/生成/TTS/播放各阶段停止 → 再次说话，确认无旧字幕/旧语音 → 关闭服务、拔插设备后恢复。
