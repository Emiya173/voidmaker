"""按需拉起本机推理服务(TTS/STT)。

`--services` 启动参数用:探测服务端口,不在线且配了 start_command 的就拉起。
服务独立于桌宠生命周期(detached,退出不回收)——冷启动贵(GPT-SoVITS ~20s),
留着给下次用。启动命令含个人环境路径,写在 config.toml,不入代码库:

    [tts]
    start_command = "cd ~/dev/gpt-sovits && nix develop --command python api_v2.py ..."
    [stt]
    start_command = "cd ~/dev/whisper-cpp && nix develop -c ./serve.sh"

拉起是 fire-and-forget:不等就绪,预热期间 TTS/STT 走各自的优雅降级。
服务日志追加在 ~/.local/state/voidmaker/<name>-server.log。
"""

from __future__ import annotations

import socket
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from .config import AppConfig

STATE_DIR = Path("~/.local/state/voidmaker").expanduser()


def port_open(url: str, timeout: float = 1.0) -> bool:
    parts = urlsplit(url)
    host = parts.hostname or "127.0.0.1"
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def spawn_detached(name: str, command: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (STATE_DIR / f"{name}-server.log").open("ab") as log:
        subprocess.Popen(
            command,
            shell=True,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


def start_services(cfg: AppConfig) -> list[str]:
    """拉起未在线的已配置服务,返回本次实际拉起的名字(tts/stt)。"""
    targets = [
        ("tts", cfg.tts.enabled, cfg.tts.api_url, cfg.tts.start_command),
        ("stt", cfg.stt.enabled, cfg.stt.server_url, cfg.stt.start_command),
    ]
    started = []
    for name, enabled, url, command in targets:
        if not (enabled and url and command) or port_open(url):
            continue
        spawn_detached(name, command)
        started.append(name)
    return started
