import json

from voidmaker.agent.client import build_system_prompt
from voidmaker.agent.curator import _format_history
from voidmaker.storage.memory import CharacterMemory


def test_memory_append_read_replace(tmp_path):
    mem = CharacterMemory("t", base_dir=tmp_path)
    assert mem.read() == ""
    mem.append("用户喜欢猫")
    assert "用户喜欢猫" in mem.read()
    assert mem.read().startswith("- [")  # 带日期条目
    mem.replace("- 整理后的唯一条目")
    assert mem.read() == "- 整理后的唯一条目\n"


def test_memory_consolidated_offset(tmp_path):
    mem = CharacterMemory("t", base_dir=tmp_path)
    assert mem.consolidated_offset() == 0
    mem.set_consolidated_offset(1234)
    assert mem.consolidated_offset() == 1234
    # 状态文件损坏时回退 0
    (tmp_path / "t.state.json").write_text("垃圾", encoding="utf-8")
    assert mem.consolidated_offset() == 0


def test_format_history_mixed_records():
    lines = [
        json.dumps({"ts": 1, "role": "user", "content": "你好"}, ensure_ascii=False),
        json.dumps(
            {"ts": 2, "role": "assistant", "content": [{"ja": "やあ", "zh": "呀"}, {"zh": "在忙?"}]},
            ensure_ascii=False,
        ),
        "坏行不是 json",
    ]
    text = _format_history(lines)
    assert "user: 你好" in text
    assert "assistant: 呀 / 在忙?" in text
    assert "坏行" not in text


def test_system_prompt_includes_memory():
    prompt = build_system_prompt(None, "- 用户在写桌宠项目")
    assert "用户在写桌宠项目" in prompt
    assert "长期记忆" in prompt
    # 无记忆时不注入该段
    assert "长期记忆" not in build_system_prompt(None, "   ")
