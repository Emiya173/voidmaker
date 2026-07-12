import socket

from voidmaker import services
from voidmaker.config import AppConfig, STTConfig, TTSConfig
from voidmaker.services import port_open, start_services


def make_cfg(**kw) -> AppConfig:
    return AppConfig(**kw)


def test_port_open_detects_listener():
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        assert port_open(f"http://127.0.0.1:{port}/tts")
    assert not port_open(f"http://127.0.0.1:{port}/tts")


def test_start_services_spawns_only_offline_configured(monkeypatch):
    spawned = []
    monkeypatch.setattr(services, "spawn_detached", lambda name, cmd: spawned.append((name, cmd)))
    monkeypatch.setattr(services, "port_open", lambda url, timeout=1.0: "9880" in url)  # 仅 TTS 在线

    cfg = make_cfg(
        tts=TTSConfig(enabled=True, start_command="run-tts"),  # 在线 → 跳过
        stt=STTConfig(server_url="http://127.0.0.1:9881", start_command="run-stt"),
    )
    assert start_services(cfg) == ["stt"]
    assert spawned == [("stt", "run-stt")]


def test_start_services_skips_unconfigured(monkeypatch):
    monkeypatch.setattr(services, "port_open", lambda url, timeout=1.0: False)
    monkeypatch.setattr(
        services, "spawn_detached",
        lambda name, cmd: (_ for _ in ()).throw(AssertionError("不应拉起")),
    )
    cfg = make_cfg(
        tts=TTSConfig(enabled=True),  # 没配 start_command
        stt=STTConfig(enabled=False, server_url="http://127.0.0.1:9881", start_command="x"),
        # stt.enabled=False → 跳过;server_url 未配时同理
    )
    assert start_services(cfg) == []