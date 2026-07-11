"""GPT-SoVITS TTS 客户端(HTTP,api_v2 契约,与 sakura 兼容)。

- 合成:POST JSON 到 /tts,响应体即 wav 字节
- 流式合成:streaming_mode=true,首块为 0 长度 data 的 wav 头,后续 raw PCM;
  mpv 从 stdin 读这种流式 wav 会一直播到 EOF(已实测)
- 角色权重:GET {base}/set_gpt_weights|set_sovits_weights?weights_path=<绝对路径>
推理服务独立运行(本机 ~/dev/gpt-sovits 或任何机器),播放走 mpv 子进程。
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx

from ..config import TTSConfig
from .tone_refs import ToneRef

_LATIN_RE = re.compile(r"[A-Za-z]")


def resolve_text_lang(text: str, default: str) -> str:
    """混合语言文本(日文夹英文如 'reply.py')用 auto,纯目标语言用 default。
    ja/zh 前端遇到拉丁字母会合成失败,auto 由服务端做多语种切分。"""
    return "auto" if _LATIN_RE.search(text) else default

DEFAULT_SYNTH_PARAMS = {
    "text_split_method": "cut1",
    "batch_size": 1,
    "media_type": "wav",
    "streaming_mode": False,
    "top_k": 15,
    "top_p": 1,
    "temperature": 1,
    "repetition_penalty": 1.2,
}


def build_payload(text: str, text_lang: str, ref: ToneRef, overrides: dict | None = None) -> dict:
    payload = {
        "text": text,
        "text_lang": resolve_text_lang(text, text_lang),
        # 服务端按自身 cwd 解析路径,必须发绝对路径
        "ref_audio_path": str(ref.audio_path.resolve()),
        "prompt_text": ref.prompt_text,
        "prompt_lang": ref.prompt_lang,
        **DEFAULT_SYNTH_PARAMS,
    }
    if overrides:
        payload.update(overrides)
    return payload


def _endpoint_url(api_url: str, endpoint: str, query: dict) -> str:
    parts = urlsplit(api_url)
    base_path = parts.path.rsplit("/", 1)[0]  # /tts → ""
    return urlunsplit((parts.scheme, parts.netloc, f"{base_path}/{endpoint}", urlencode(query), ""))


class TTSClient:
    def __init__(self, cfg: TTSConfig):
        self._cfg = cfg
        self._http = httpx.AsyncClient(timeout=120.0)

    async def set_character_weights(self, gpt_model: Path | None, sovits_model: Path | None) -> None:
        for endpoint, path in (("set_gpt_weights", gpt_model), ("set_sovits_weights", sovits_model)):
            if path is None:
                continue
            url = _endpoint_url(self._cfg.api_url, endpoint, {"weights_path": str(path.resolve())})
            resp = await self._http.get(url)
            resp.raise_for_status()

    async def synthesize(self, text: str, text_lang: str, ref: ToneRef) -> bytes:
        payload = build_payload(text, text_lang, ref, self._cfg.params)
        resp = await self._http.post(self._cfg.api_url, json=payload)
        resp.raise_for_status()
        return resp.content

    async def synthesize_stream(self, text: str, text_lang: str, ref: ToneRef) -> AsyncIterator[bytes]:
        """流式合成:按合成进度逐块产出音频(wav 头 + raw PCM)。

        streaming_mode 可在 params 里覆盖(api_v2:1/true=按完整句段,首块最慢;
        2=中等质量按块;3=定长块,首块最快但音质毛糙)。单句分段用 1 等于没有
        流式,默认 2(听感优先)。
        """
        payload = build_payload(text, text_lang, ref, self._cfg.params)
        if not payload.get("streaming_mode"):
            payload["streaming_mode"] = 2
        async with self._http.stream("POST", self._cfg.api_url, json=payload) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk

    async def play_stream(self, chunks: AsyncIterator[bytes]) -> None:
        """边收边播:把音频块喂进 mpv 的 stdin,收完即 EOF、播完退出。"""
        proc = await asyncio.create_subprocess_exec(
            "mpv", "--no-terminal", "--force-window=no",
            "--keep-open=no", "--idle=no", "-",
            stdin=asyncio.subprocess.PIPE,
        )
        try:
            async for chunk in chunks:
                proc.stdin.write(chunk)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # mpv 提前退出(如被杀),剩余块丢弃
        finally:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
            await proc.wait()

    async def play(self, audio: bytes) -> None:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False, prefix="voidmaker-tts-") as f:
            f.write(audio)
            path = Path(f.name)
        try:
            # 覆盖用户 mpv.conf 的 keep-open/idle,否则播放完不退出、队列卡死
            proc = await asyncio.create_subprocess_exec(
                "mpv", "--no-terminal", "--force-window=no",
                "--keep-open=no", "--idle=no", str(path),
            )
            await proc.wait()
        finally:
            path.unlink(missing_ok=True)

    async def aclose(self) -> None:
        await self._http.aclose()
