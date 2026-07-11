import asyncio
import json
from pathlib import Path

import httpx
import pytest

from voidmaker.config import TTSConfig
from voidmaker.voice.client import TTSClient, build_payload, _endpoint_url, resolve_text_lang
from voidmaker.voice.tone_refs import ToneRef, load_tone_refs, select_ref

REAL_PACKAGE = Path(__file__).parent.parent / "characters" / "sakura"


def make_ref_file(tmp_path: Path) -> Path:
    refs_dir = tmp_path / "voice" / "refs"
    (refs_dir / "tone_refs").mkdir(parents=True)
    (refs_dir / "tone_refs" / "a.ogg").write_bytes(b"x")
    ref = refs_dir / "ref.txt"
    ref.write_text(
        "voice/refs/tone_refs/a.ogg|JA|こんにちは|中性\n"
        "# 注释行\n"
        "坏行没有四段\n"
        "voice/refs/tone_refs/b.wav|JA|お願い|请求\n",
        encoding="utf-8",
    )
    return ref


def test_load_tone_refs(tmp_path):
    refs = load_tone_refs(make_ref_file(tmp_path), tmp_path)
    assert set(refs) == {"中性", "请求"}
    # tone_refs/ 同级文件存在则优先使用
    assert refs["中性"].audio_path == tmp_path / "voice/refs/tone_refs/a.ogg"
    assert refs["中性"].prompt_lang == "ja"
    # b.wav 不存在于 tone_refs/,回退包相对路径
    assert refs["请求"].audio_path == tmp_path / "voice/refs/tone_refs/b.wav"


def test_select_ref_fallback(tmp_path):
    refs = load_tone_refs(make_ref_file(tmp_path), tmp_path)
    assert select_ref(refs, "请求").tone == "请求"
    assert select_ref(refs, "不存在的语气").tone == "中性"  # 兜底中性
    assert select_ref({}, "中性") is None


def test_build_payload():
    ref = ToneRef(tone="中性", audio_path=Path("/abs/a.ogg"), prompt_text="こん", prompt_lang="ja")
    payload = build_payload("テスト", "ja", ref, overrides={"temperature": 0.9})
    assert payload["text"] == "テスト"
    assert payload["ref_audio_path"] == "/abs/a.ogg"
    assert payload["prompt_text"] == "こん"
    assert payload["media_type"] == "wav"
    assert payload["temperature"] == 0.9  # overrides 生效
    assert payload["text_split_method"] == "cut1"


def test_resolve_text_lang():
    assert resolve_text_lang("……起動した。", "ja") == "ja"
    assert resolve_text_lang("その reply.py、直してるの。", "ja") == "auto"  # 混英文 → auto
    ref = ToneRef(tone="中性", audio_path=Path("/a.ogg"), prompt_text="x", prompt_lang="ja")
    assert build_payload("sudo は危ない", "ja", ref)["text_lang"] == "auto"


def test_endpoint_url():
    url = _endpoint_url("http://127.0.0.1:9880/tts", "set_gpt_weights", {"weights_path": "/m/a.ckpt"})
    assert url == "http://127.0.0.1:9880/set_gpt_weights?weights_path=%2Fm%2Fa.ckpt"


async def test_synthesize_stream_payload_and_chunks():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, content=b"RIFF....pcmpcm")

    client = TTSClient(TTSConfig(params={"temperature": 0.9}))
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ref = ToneRef(tone="中性", audio_path=Path("/abs/a.ogg"), prompt_text="こん", prompt_lang="ja")
    chunks = [c async for c in client.synthesize_stream("テスト", "ja", ref)]
    assert b"".join(chunks) == b"RIFF....pcmpcm"
    assert captured["json"]["streaming_mode"] == 2  # 默认中等质量按块流式
    assert captured["json"]["temperature"] == 0.9  # 配置 params 仍透传

    # params 里显式指定 streaming_mode 时不被覆盖
    client2 = TTSClient(TTSConfig(params={"streaming_mode": 3}))
    client2._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    _ = [c async for c in client2.synthesize_stream("テスト", "ja", ref)]
    assert captured["json"]["streaming_mode"] == 3
    await client.aclose()
    await client2.aclose()


async def test_drain_stops_at_sentinel():
    from voidmaker.ui.voice_worker import _drain

    queue: asyncio.Queue = asyncio.Queue()
    for item in (b"a", b"b", None):
        queue.put_nowait(item)
    assert [c async for c in _drain(queue)] == [b"a", b"b"]


def test_config_defaults():
    from voidmaker.config import ScreenAwarenessConfig

    assert TTSConfig().streaming is True
    assert ScreenAwarenessConfig().precheck_model == "claude-haiku-4-5"


@pytest.mark.skipif(not REAL_PACKAGE.is_dir(), reason="真实角色包未解压")
def test_real_package_tone_refs():
    ref_path = REAL_PACKAGE / "voice" / "refs" / "ref.txt"
    refs = load_tone_refs(ref_path, REAL_PACKAGE)
    assert "中性" in refs
    for ref in refs.values():
        assert ref.audio_path.is_file(), f"参考音频缺失: {ref.audio_path}"
        assert ref.prompt_text
