"""扫描 characters/<id>/character.json 并加载角色卡。

与 sakura 的差异:sakura 对缺失文件直接抛错;这里取宽容策略——
路径照记(UI/语音侧使用前自行检查存在性),坏 JSON 才跳过整个包。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .model import CharacterCard, VoiceConfig


def _resolve(package_dir: Path, text: Any) -> Path | None:
    if not isinstance(text, str) or not text.strip():
        return None
    path = Path(text.strip().strip('"').strip("'"))
    return path if path.is_absolute() else package_dir / path


def _load_persona(package_dir: Path, card_rel: Any) -> str:
    card_path = _resolve(package_dir, card_rel)
    if card_path is None or not card_path.is_file():
        return ""
    try:
        return card_path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def load_character(package_dir: Path) -> CharacterCard:
    # 立即固定为绝对路径:包内资源路径会跨进程传递(如 TTS 服务按自身 cwd 解析),
    # 相对路径出程序边界即失效
    package_dir = package_dir.resolve()
    manifest = package_dir / "character.json"
    raw = json.loads(manifest.read_text(encoding="utf-8"))

    portrait_data = raw.get("portrait") or {}
    expressions: dict[str, Path] = {}
    for tone, rel in (portrait_data.get("expressions") or {}).items():
        path = _resolve(package_dir, rel)
        if isinstance(tone, str) and tone.strip() and path is not None:
            expressions[tone.strip()] = path

    reply_data = raw.get("reply") or {}
    raw_tones = reply_data.get("tones") if isinstance(reply_data, dict) else None
    tones = [t.strip() for t in raw_tones if isinstance(t, str) and t.strip()] if isinstance(raw_tones, list) else []

    voice = None
    voice_data = raw.get("voice")
    if isinstance(voice_data, dict):
        voice = VoiceConfig(
            gpt_model=_resolve(package_dir, voice_data.get("gpt_model")),
            sovits_model=_resolve(package_dir, voice_data.get("sovits_model")),
            tone_refs=_resolve(package_dir, voice_data.get("tone_refs")),
            ref_lang=voice_data.get("ref_lang") or "ja",
            text_lang=voice_data.get("text_lang") or "ja",
        )

    kwargs: dict[str, Any] = dict(
        id=raw.get("id", package_dir.name),
        display_name=raw.get("display_name", package_dir.name),
        persona=_load_persona(package_dir, raw.get("card")),
        default_portrait=_resolve(package_dir, portrait_data.get("default")),
        expression_portraits=expressions,
        voice=voice,
        backchannel_manifest=_resolve(package_dir, raw.get("backchannel")),
        theme=raw.get("theme") if isinstance(raw.get("theme"), dict) else {},
        renderer=raw.get("renderer") if isinstance(raw.get("renderer"), dict) else None,
        package_dir=package_dir,
    )
    if tones:
        kwargs["tones"] = tones
    initial = raw.get("initial_message")
    if isinstance(initial, str) and initial.strip():
        kwargs["initial_message"] = initial.strip()
    return CharacterCard(**kwargs)


def scan_characters(characters_dir: Path) -> dict[str, CharacterCard]:
    cards: dict[str, CharacterCard] = {}
    if not characters_dir.is_dir():
        return cards
    for manifest in sorted(characters_dir.glob("*/character.json")):
        try:
            card = load_character(manifest.parent)
            cards[card.id] = card
        except (json.JSONDecodeError, OSError) as exc:
            print(f"[voidmaker] 跳过损坏的角色包 {manifest.parent.name}: {exc}")
    return cards
