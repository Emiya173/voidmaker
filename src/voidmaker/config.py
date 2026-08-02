"""运行配置:~/.config/voidmaker/config.toml,环境变量优先。"""

from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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
    provider: Literal["claude", "codex"] = "claude"
    # 主对话模型;None = 使用所选 CLI 的默认模型
    model: str | None = None
    # Codex 推理强度(low/medium/high/xhigh 等);None = 使用 Codex CLI 配置
    reasoning_effort: str | None = None
    # 记忆整理模型;None = 使用所选 CLI 的默认模型
    auxiliary_model: str | None = None
    max_turns: int | None = None

    @model_validator(mode="after")
    def _provider_defaults(self):
        # 保持原有 Claude 默认值;Codex 默认跟随 CLI 当前推荐模型。
        # 显式 model="" 已被 SectionModel 转成 None,此时仍表示 CLI 默认。
        if self.provider == "claude":
            if "model" not in self.model_fields_set:
                self.model = "claude-sonnet-5"
            if "auxiliary_model" not in self.model_fields_set:
                self.auxiliary_model = "claude-haiku-4-5"
        return self


class ScreenAwarenessConfig(SectionModel):
    """主动屏幕感知:周期截屏自判是否开口。默认关闭。"""

    enabled: bool = False
    interval_minutes: float = 20.0  # 检查周期
    cooldown_minutes: float = 10.0  # 两次主动发言的最小间隔
    # 高频预判用的廉价模型:先让它看截图判断值不值得开口,值得才动用主模型。
    # None = 关闭预判,每次直接注入主 agent(旧行为,主模型按周期计费)
    precheck_model: str | None = "claude-haiku-4-5"
    # Codex 预判的独立推理强度;None = 使用 Codex CLI 配置。
    precheck_reasoning_effort: str | None = None


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


class UIConfig(SectionModel):
    """桌宠窗口行为。"""

    # 显示字幕气泡;false = 纯语音/立绘,且窗口不含气泡区——立绘上方无窗口、
    # 点击天然穿透(权限请示时气泡区临时展开,答完收回)
    bubble_enabled: bool = True
    # 整轮回复播完(TTS 播放/字幕都结束)后气泡再停留的秒数;0 = 一直显示
    bubble_hide_seconds: float = 5.0
    # 输入条只在窗口获得焦点时显示(点桌宠即聚焦);false = 常显
    input_focus_only: bool = True


class AppConfig(SectionModel):
    agent: AgentConfig = Field(default_factory=AgentConfig)
    ui: UIConfig = Field(default_factory=UIConfig)
    tts: TTSConfig = Field(default_factory=TTSConfig)
    screen_awareness: ScreenAwarenessConfig = Field(default_factory=ScreenAwarenessConfig)
    stt: STTConfig = Field(default_factory=STTConfig)
    homelab: HomelabConfig = Field(default_factory=HomelabConfig)
    characters_dir: Path = Path("characters")
    current_character: str | None = None

    @model_validator(mode="after")
    def _align_provider_defaults(self):
        # Codex 模式不应因默认的 Haiku 预判而隐式要求 Claude Code 登录。
        if (
            self.agent.provider == "codex"
            and "precheck_model" not in self.screen_awareness.model_fields_set
        ):
            self.screen_awareness.precheck_model = None
        return self


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
