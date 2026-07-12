"""运行配置:~/.config/voidmaker/config.toml,环境变量优先。"""

from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

CONFIG_PATH = Path(os.environ.get("VOIDMAKER_CONFIG", "~/.config/voidmaker/config.toml")).expanduser()
DATA_DIR = Path(os.environ.get("VOIDMAKER_DATA", "~/.local/share/voidmaker")).expanduser()


class SectionModel(BaseModel):
    """TOML 无 null:空字符串 "" 一律视为 None(如 agent.model = "" 表示用 CLI 默认)。"""

    @field_validator("*", mode="before")
    @classmethod
    def _empty_str_is_none(cls, v):
        return None if v == "" else v


class TTSConfig(SectionModel):
    enabled: bool = False
    # 本机 GPT-SoVITS API(~/dev/gpt-sovits);迁移到其他机器时只改这里
    api_url: str = "http://127.0.0.1:9880/tts"
    # 段内流式:边合成边播放(GPT-SoVITS streaming_mode),首句延迟从整段合成降为首个片段
    streaming: bool = True
    # 直接透传给 GPT-SoVITS /tts 的默认参数(ref_audio_path、text_lang 等)
    params: dict = Field(default_factory=dict)
    # --services 拉起用的启动命令(服务不在线时经 sh 执行;含个人路径,只写 config.toml)
    start_command: str | None = None


class AgentConfig(SectionModel):
    # 主对话模型;None = 用 Claude Code CLI 的默认模型,也可写 "claude-opus-4-8" 等
    # (主动感知预判/记忆整理另有各自的廉价模型,见 screen_awareness.precheck_model)
    model: str | None = "claude-sonnet-5"
    max_turns: int | None = None


class ScreenAwarenessConfig(SectionModel):
    """主动屏幕感知:周期截屏自判是否开口。默认关闭。"""

    enabled: bool = False
    interval_minutes: float = 20.0  # 检查周期
    cooldown_minutes: float = 10.0  # 两次主动发言的最小间隔
    # 高频预判用的廉价模型:先让它看截图判断值不值得开口,值得才动用主模型。
    # None = 关闭预判,每次直接注入主 agent(旧行为,主模型按周期计费)
    precheck_model: str | None = "claude-haiku-4-5"


class HomelabConfig(SectionModel):
    """家庭服务器状态查询(homelab-hub 聚合层,只读)。迁移/换网只改 hub_url。

    默认关闭:hub_url 是用户自己的内网地址,填在 ~/.config/voidmaker/config.toml,
    不硬编码进代码。
    """

    enabled: bool = False
    hub_url: str = "http://127.0.0.1:9201"  # 占位;真实内网地址由 config.toml 覆盖


class STTConfig(SectionModel):
    """语音输入(faster-whisper CPU,进程内;模型懒加载)。

    server_url 指向 whisper.cpp 服务(~/dev/whisper-cpp,Vulkan/GPU)时优先走
    HTTP,服务不在线自动回退进程内 faster-whisper。
    """

    enabled: bool = True
    model: str = "small"  # tiny/base/small/medium
    language: str | None = "zh"  # None = 自动检测
    server_url: str | None = None  # 如 http://127.0.0.1:9881;None = 仅本地
    # --services 拉起用的启动命令(服务不在线时经 sh 执行;含个人路径,只写 config.toml)
    start_command: str | None = None


class AppConfig(SectionModel):
    agent: AgentConfig = Field(default_factory=AgentConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    screen_awareness: ScreenAwarenessConfig = Field(default_factory=ScreenAwarenessConfig)
    stt: STTConfig = Field(default_factory=STTConfig)
    homelab: HomelabConfig = Field(default_factory=HomelabConfig)
    characters_dir: Path = Path("characters")
    current_character: str | None = None


def load_config() -> AppConfig:
    if CONFIG_PATH.exists():
        raw = tomllib.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        cfg = AppConfig.model_validate(raw)
    else:
        legacy = CONFIG_PATH.with_name("config.yaml")
        if legacy.exists():
            print(f"[voidmaker] 配置已改用 TOML:请把 {legacy} 转写为 {CONFIG_PATH}", file=sys.stderr)
        cfg = AppConfig()
    # 快捷开关:VOIDMAKER_TTS=1/0 覆盖配置(便于临时验证)
    tts_env = os.environ.get("VOIDMAKER_TTS")
    if tts_env is not None:
        cfg.tts.enabled = tts_env not in ("0", "false", "")
    # VOIDMAKER_PROACTIVE_SEC=15 → 启用主动感知并把周期设为 15 秒(仅测试用)
    proactive_env = os.environ.get("VOIDMAKER_PROACTIVE_SEC")
    if proactive_env:
        cfg.screen_awareness.enabled = True
        cfg.screen_awareness.interval_minutes = float(proactive_env) / 60.0
        cfg.screen_awareness.cooldown_minutes = 0.0
    return cfg
