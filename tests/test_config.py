import tomllib
from pathlib import Path

from voidmaker.config import AgentConfig, AppConfig, STTConfig

EXAMPLE = Path(__file__).parent.parent / "docs" / "config.example.toml"


def test_empty_string_means_none():
    assert AgentConfig(model="").model is None
    assert STTConfig(language="").language is None
    assert AppConfig(current_character="").current_character is None


def test_example_config_parses_and_validates():
    text = EXAMPLE.read_text(encoding="utf-8")
    AppConfig.model_validate(tomllib.loads(text))  # 注释状态(几乎全默认)

    # 把注释掉的字段行全部启用,应仍是合法配置(防模板和 config.py 脱节)
    uncommented = "\n".join(
        line[2:] if line.startswith("# ") and "=" in line else line
        for line in text.splitlines()
    )
    AppConfig.model_validate(tomllib.loads(uncommented))
