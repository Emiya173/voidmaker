import tomllib
from pathlib import Path

from voidmaker.config import AgentConfig, AppConfig, STTConfig

EXAMPLE = Path(__file__).parent.parent / "docs" / "config.example.toml"


def test_empty_string_means_none():
    assert AgentConfig(model="").model is None
    assert AgentConfig(auxiliary_model="").auxiliary_model is None
    assert STTConfig(language="").language is None
    assert AppConfig(current_character="").current_character is None


def test_agent_provider_defaults_do_not_cross_require_clis():
    claude = AppConfig()
    assert claude.agent.provider == "claude"
    assert claude.agent.model == "claude-sonnet-5"
    assert claude.agent.auxiliary_model == "claude-haiku-4-5"
    assert claude.screen_awareness.precheck_model == "claude-haiku-4-5"

    codex = AppConfig.model_validate({"agent": {"provider": "codex"}})
    assert codex.agent.model is None
    assert codex.agent.auxiliary_model is None
    assert codex.screen_awareness.precheck_model is None


def test_codex_can_use_explicit_models():
    cfg = AppConfig.model_validate(
        {
            "agent": {
                "provider": "codex",
                "model": "gpt-5.4",
                "reasoning_effort": "medium",
                "auxiliary_model": "gpt-5.4-mini",
            },
            "screen_awareness": {"precheck_model": "gpt-5.4-mini"},
        }
    )
    assert cfg.agent.model == "gpt-5.4"
    assert cfg.agent.reasoning_effort == "medium"
    assert cfg.agent.auxiliary_model == "gpt-5.4-mini"
    assert cfg.screen_awareness.precheck_model == "gpt-5.4-mini"


def test_example_config_parses_and_validates():
    text = EXAMPLE.read_text(encoding="utf-8")
    AppConfig.model_validate(tomllib.loads(text))  # 注释状态(几乎全默认)

    # 把注释掉的字段行全部启用,应仍是合法配置(防模板和 config.py 脱节)
    uncommented = "\n".join(
        line[2:] if line.startswith("# ") and "=" in line else line
        for line in text.splitlines()
    )
    AppConfig.model_validate(tomllib.loads(uncommented))
