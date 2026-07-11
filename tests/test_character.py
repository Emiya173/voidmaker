import json
from pathlib import Path

import pytest

from voidmaker.character.loader import load_character, scan_characters
from voidmaker.character.model import DEFAULT_TONES

REAL_PACKAGE = Path(__file__).parent.parent / "characters" / "sakura"


def make_package(tmp_path, char_id="miko"):
    pkg = tmp_path / char_id
    (pkg / "portraits").mkdir(parents=True)
    (pkg / "card.md").write_text("你是神社的巫女。", encoding="utf-8")
    (pkg / "character.json").write_text(
        json.dumps(
            {
                "id": char_id,
                "display_name": "巫女",
                "initial_message": "おはよう。",
                "card": "card.md",
                "portrait": {
                    "default": "portraits/default.png",
                    "expressions": {"微笑": "portraits/happy.png"},
                },
                "reply": {"tones": ["中性", "开心"]},
                "voice": {
                    "tone_refs": "voice/refs/ref.txt",
                    "gpt_model": "voice/models/a.ckpt",
                    "sovits_model": "voice/models/b.pth",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return pkg


def test_load_character(tmp_path):
    pkg = make_package(tmp_path)
    card = load_character(pkg)
    assert card.id == "miko"
    assert card.persona == "你是神社的巫女。"
    assert card.initial_message == "おはよう。"
    assert card.tones == ["中性", "开心"]
    assert card.voice is not None
    assert card.voice.gpt_model == pkg / "voice/models/a.ckpt"
    assert card.voice.text_lang == "ja"
    # 立绘选择:标识优先 → 语气兜底 → 默认
    assert card.portrait_for("微笑") == pkg / "portraits/happy.png"
    assert card.portrait_for("不存在", tone="微笑") == pkg / "portraits/happy.png"
    assert card.portrait_for(None) == pkg / "portraits/default.png"


def test_defaults_when_fields_missing(tmp_path):
    pkg = tmp_path / "bare"
    pkg.mkdir()
    (pkg / "character.json").write_text(json.dumps({"id": "bare"}), encoding="utf-8")
    card = load_character(pkg)
    assert card.tones == DEFAULT_TONES
    assert card.voice is None
    assert card.persona == ""


def test_scan_skips_broken_package(tmp_path):
    make_package(tmp_path)
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "character.json").write_text("{ 不是json", encoding="utf-8")
    cards = scan_characters(tmp_path)
    assert list(cards) == ["miko"]


@pytest.mark.skipif(not REAL_PACKAGE.is_dir(), reason="真实角色包未解压(characters/sakura)")
def test_load_real_sakura_package():
    card = load_character(REAL_PACKAGE)
    assert card.id == "Sakura"
    assert card.display_name == "夜乃桜"
    assert "夜乃桜" in card.persona or len(card.persona) > 100
    assert card.default_portrait is not None and card.default_portrait.is_file()
    assert "吃醋不满" in card.expression_portraits
    assert card.voice is not None and card.voice.tone_refs.is_file()
    assert card.theme.get("primary_color") == "#d55b91"
