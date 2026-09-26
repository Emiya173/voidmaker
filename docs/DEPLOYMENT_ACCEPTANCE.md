# Qwen3-ASR-0.6B 部署与实机验收

日期：2026-09-26。目标：NixOS + niri + Quickshell，AMD Navi 48 / gfx1201，约 16 GB 显存。

## 结论

**本地模型部署、现有音频识别、Codex 对话、TTS、实际扬声器播放及播放中断已通过。**
用户确认“能听清，播放正常”。按用户本轮选择，没有启动真实麦克风录音；真人口语、麦克风 VAD、
连续对话的声学效果及声学插话仍未验收。小样本结果不代表通用识别准确率。

## 已部署组件

| 组件 | 部署版本 / 方式 | 访问方式 |
| --- | --- | --- |
| ASR | Qwen3-ASR-0.6B，Transformers / ROCm，BF16、SDPA、单请求推理 | `127.0.0.1:8000/v1/audio/transcriptions` |
| 模型 revision | `5eb144179a02acc5e5ba31e748d22b0cf3e303b0` | 本地快照，运行时离线加载 |
| ASR 环境 | qwen-asr 0.0.6、Transformers 4.57.6、PyTorch 2.11.0+rocm7.2、Python 3.11 | 独立 `~/dev/qwen3-asr-service`，含 `flake.lock` / `uv.lock` |
| TTS | 现有 GPT-SoVITS 环境，仓库基线 `2dbec94`，保留其已有本机修改 | `127.0.0.1:9880/tts` |
| TTS 权重 | 通用 `s1v3.ckpt` + `v2Pro/s2Gv2ProPlus.pth`，使用本机已有参考音频 | 配置独立于原服务配置 |
| 数据库 | PostgreSQL 17，本机用户实例，peer 认证 | 私有 Unix socket，无 TCP 监听 |
| 应用 | 编译后的 TypeScript Host + Quickshell 新界面 | `$XDG_RUNTIME_DIR/voidmaker/host.sock` |

官方权重从 ModelScope 镜像获取，SHA-256 与锁定 Hugging Face 快照中的 LFS 哈希一致：
`79d6cbd4c98c7bbffe9db2edac07f56cd6637d0d5944b27f6c2b8353840323ea`。
选择 Transformers 后端是为了先交付当前非流式、半双工路径；本轮没有安装或验证 vLLM 流式服务。
ASR 是独立推理服务中的少量 Python，应用音频编排与业务逻辑仍为 TypeScript。

## 服务与配置

以下 `systemd --user` 服务均已启动并启用：

- `voidmaker-postgres.service`
- `voidmaker-asr.service`
- `voidmaker-tts.service`
- `voidmaker-host.service`
- `voidmaker-shell.service`（随图形会话启动）

用户服务不会自动赋予系统级启动权限；未配置用户 linger。服务模板位于
[systemd 模板目录](systemd/)和 [Host 模板](voidmaker-host.service)。
模板中的开发目录须按安装机器调整，且需预先准备外部推理环境、模型快照和数据库。

本机配置与数据位置：

- `~/.config/voidmaker/voice.json`：选定 ASR、TTS、USB 麦克风节点。
- `~/.config/voidmaker/tts-infer.yaml`：当前 TTS 模型配置；此前配置另存 `.sakura-backup`。
- `~/.local/state/voidmaker/postgres`：持久 PostgreSQL 数据。
- `~/.local/state/voidmaker/acceptance/2026-09-26/`：验收音频与完整指标，仅本机保存。
- `~/dev/qwen3-asr-service/server.py`：独立 HTTP 推理入口；不记录上传音频或转写。

ASR 仅接受指定模型、JSON 输出和最多 60 秒 / 4 MiB 音频，正在推理时返回 429。
它不会隐式回退 CPU、Whisper 或远程服务。取消 HTTP 请求不会强制中止已经提交的 GPU kernel，
服务在计算结束前保持单任务锁，防止重叠推理。

常用操作：

```sh
systemctl --user status voidmaker-{postgres,asr,tts,host,shell}.service
curl --fail http://127.0.0.1:8000/health
journalctl --user -u voidmaker-asr.service -n 30 --no-pager
# 改应用语音配置后：
systemctl --user restart voidmaker-host.service
# 停止整个助手，包括释放模型资源：
systemctl --user stop voidmaker-{shell,host,asr,tts,postgres}.service
# 恢复（Host 会拉起数据库与模型服务）：
systemctl --user start voidmaker-shell.service
```

## ASR 实测

以下是服务预热后的完整请求耗时，包括 HTTP 与服务推理，不含录音或 VAD 等待：

| 输入 | 音频时长 | 请求耗时 | RTF | 结果 |
| --- | ---: | ---: | ---: | --- |
| Qwen 官方中文样本 | 4.204 s | 165 ms | 0.039 | 与官方示例转写一致，CER 0 |
| 通用 TTS 合成的中英混合测试句 | 5.600 s | 231 ms | 0.041 | 回环 CER 13.3%，两个专名命中一个 |
| 数字静音 | 1.000 s | 68 ms | 0.068 | 空转写，无幻觉 |

官方英文样本也成功返回英文转写，但没有独立校验过的参考文本，因此不计算其 CER。
混合句属于 **TTS → ASR 回环**，错误可能来自合成发音或识别，不能当作真人语音的 ASR 独立准确率。
专名和混说质量仍需真人录音进一步验证；当前没有基于这几条样本宣称总体质量达标。

ASR 预热后，PyTorch 报告已分配 GPU 内存约 1.54 GiB、保留约 1.77 GiB；这不包含全部 ROCm 上下文、
驱动开销或 TTS 显存。服务 cgroup 内存约 1.64 GiB，均为该轮运行的快照，不是峰值或部署最低要求。

完整结果保存于本机 `asr-report-base-tts.json`。早期诊断结果 `asr-report.json` 也保留，
用于追溯日语角色 TTS 导致的异常回环；它不是最终 ASR 质量报告。

## 整链路与取消

使用已有中文 WAV 调用真实 ASR，将转写交给 Host，请 Codex 返回一句固定的简短测试回复。
随后由真实 GPT-SoVITS 合成、mpv 经桌面音频设备播放，用户确认听感正常。

| 时间点 / 检查 | 测量结果 |
| --- | --- |
| ASR 完成 | 182 ms |
| Codex 首段文字 | 自请求起 2.01 s |
| Codex 回复完成 | 自请求起 2.37 s |
| Host 进入播放阶段 | 自请求起 2.91 s |
| 播放结束、回到待命 | 自请求起 5.41 s |
| 播放进度 | 收到 34 个非零进度事件 |
| 播放中停止 | 发出停止命令至 Host 回到 idle 约 5 ms |
| 停止后再次对话 | 成功回复并再次播放 |
| 取消 ASR HTTP 请求 | 客户端约 29 ms 内结束等待，之后服务健康 |
| 无效音频 | HTTP 400，无服务崩溃 |

播放阶段时间和停止时间来自 Host / mpv 控制事件，**不是声卡实际发声或静音的硬件时间戳**。
测试结束时没有遗留的录音或播放子进程。常驻服务与界面按部署要求继续运行。

## 验收中处理的问题

1. Hugging Face Xet 下载停滞：改用官方 ModelScope 镜像，并核对权重 SHA-256。
2. 新采样率首次重采样开销：ASR 包装层使用已锁定的 soxr，避免该路径首次执行 librosa/Numba JIT。
3. 原日语专用角色权重的中文回环结果异常：对照后采用通用预训练 TTS 权重，保留原配置备份。
   当前应用 TTS `textLanguage=zh`，参考音频的语言仍按实际素材设置；没有改写原 GPT-SoVITS 仓库的角色配置。

## 后续真人验收

本轮用户选择“先用现有音频验收，稍后再录”，因此没有打开麦克风。
USB 麦克风已在线并配置为输入。下一轮可从界面“开始说话”执行：

- 普通话口语、中英混说、项目名及远场识别。
- 单次录音的编辑确认、连续模式的自动恢复拾音。
- 在录音、识别、生成、合成与播放各阶段手动停止。
- 静音、键盘声、扬声器回声和设备拔插后的恢复。

能量 VAD、句末延迟和连续对话声学表现尚不能由本轮文件验收证明。声学插话/AEC 仍未实现。
