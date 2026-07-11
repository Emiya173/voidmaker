"""角色卡数据模型,对齐 sakura 的 character.json schema。

权威来源:sakura/app/config/character_loader.py。字段对应:
- id / display_name / initial_message   基本信息
- card                                  → 独立文本文件,内容为系统提示(persona)
- portrait.default / .expressions       默认立绘 + 语气→立绘映射
- reply.tones                           可用语气标签
- voice.{gpt_model,sovits_model,tone_refs,ref_lang,text_lang}  GPT-SoVITS 权重与语气参考表
- backchannel                           接话模板 manifest 路径(可选)
- theme / renderer                      原样保留(dict),分别供 UI 主题与渲染后端用
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

DEFAULT_TONES = ["中性", "不满", "害羞", "请求", "困惑", "惊讶"]
DEFAULT_INITIAL_MESSAGE = "……起動した。用事があるなら、呼んで。"


class VoiceConfig(BaseModel):
    gpt_model: Path | None = None
    sovits_model: Path | None = None
    tone_refs: Path | None = None  # 语气→参考音频映射表
    ref_lang: str = "ja"
    text_lang: str = "ja"


class CharacterCard(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    display_name: str = ""
    persona: str = ""  # card 文件内容 → 系统提示主体
    initial_message: str = DEFAULT_INITIAL_MESSAGE
    tones: list[str] = Field(default_factory=lambda: [*DEFAULT_TONES])
    default_portrait: Path | None = None
    expression_portraits: dict[str, Path] = Field(default_factory=dict)
    voice: VoiceConfig | None = None
    backchannel_manifest: Path | None = None
    theme: dict = Field(default_factory=dict)
    renderer: dict | None = None
    package_dir: Path | None = None

    @property
    def portraits(self) -> list[str]:
        return list(self.expression_portraits)

    def portrait_for(self, portrait: str | None, tone: str | None = None) -> Path | None:
        """段落立绘标识优先,其次语气,最后默认立绘(与 sakura 语义一致)。"""
        for key in (portrait, tone):
            key = (key or "").strip()
            if key and key in self.expression_portraits:
                return self.expression_portraits[key]
        return self.default_portrait
