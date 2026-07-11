"""语气参考表(tone_refs)解析。

格式(与 sakura 一致,ref.txt 每行):
    音频路径|语言|参考文本|语气
音频路径相对角色包根目录;若 ref.txt 同级 tone_refs/<文件名> 存在则优先。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

DEFAULT_TONE = "中性"


@dataclass(frozen=True)
class ToneRef:
    tone: str
    audio_path: Path
    prompt_text: str
    prompt_lang: str


def _normalize_lang(lang: str) -> str:
    return (lang or "ja").strip().lower() or "ja"


def load_tone_refs(ref_path: Path, package_dir: Path) -> dict[str, ToneRef]:
    """返回 语气 → 参考条目(每语气取第一条)。文件缺失/坏行静默跳过。"""
    refs: dict[str, ToneRef] = {}
    if not ref_path.is_file():
        return refs
    for raw_line in ref_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 4:
            continue
        audio_text, lang, prompt_text, tone = parts
        audio_path = Path(audio_text)
        if not audio_path.is_absolute():
            audio_path = package_dir / audio_path
        sibling = ref_path.parent / "tone_refs" / audio_path.name
        if sibling.exists():
            audio_path = sibling
        tone_key = tone or DEFAULT_TONE
        if tone_key not in refs:
            refs[tone_key] = ToneRef(
                tone=tone_key,
                audio_path=audio_path,
                prompt_text=prompt_text,
                prompt_lang=_normalize_lang(lang),
            )
    return refs


def select_ref(refs: dict[str, ToneRef], tone: str | None) -> ToneRef | None:
    """按语气选参考:精确匹配 → 中性 → 任意第一条。"""
    tone_key = (tone or "").strip()
    if tone_key and tone_key in refs:
        return refs[tone_key]
    if DEFAULT_TONE in refs:
        return refs[DEFAULT_TONE]
    return next(iter(refs.values()), None)
