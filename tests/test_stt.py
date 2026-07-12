import struct
import wave

import httpx

from voidmaker.config import STTConfig
from voidmaker.voice.stt import BYTES_PER_CHUNK, CHUNK_MS, SpeechSegmenter, Transcriber

SILENCE = b"\x00\x00" * (BYTES_PER_CHUNK // 2)
SPEECH = struct.pack("<h", 3000) * (BYTES_PER_CHUNK // 2)

SILENCE_CHUNKS = 800 // CHUNK_MS + 1  # 默认静音超时对应的块数


def feed_all(seg: SpeechSegmenter, chunks) -> list[bytes]:
    out = []
    for chunk in chunks:
        result = seg.feed(chunk)
        if result is not None:
            out.append(result)
    return out


def test_utterance_cut_on_silence():
    seg = SpeechSegmenter()
    chunks = [SILENCE] * 20 + [SPEECH] * 30 + [SILENCE] * SILENCE_CHUNKS
    utterances = feed_all(seg, chunks)
    assert len(utterances) == 1
    # 至少包含全部语音块(pre-roll 与尾静音另计)
    assert len(utterances[0]) >= 30 * BYTES_PER_CHUNK


def test_short_blip_discarded_as_noise():
    seg = SpeechSegmenter(min_speech_ms=250)
    chunks = [SILENCE] * 20 + [SPEECH] * 2 + [SILENCE] * SILENCE_CHUNKS
    assert feed_all(seg, chunks) == []


def test_reset_discards_partial_utterance():
    seg = SpeechSegmenter()
    for chunk in [SILENCE] * 10 + [SPEECH] * 10:
        seg.feed(chunk)
    seg.reset()  # 暂停拾音:说到一半的内容丢弃
    assert feed_all(seg, [SILENCE] * SILENCE_CHUNKS) == []


def test_two_utterances_in_sequence():
    seg = SpeechSegmenter()
    one = [SPEECH] * 20 + [SILENCE] * SILENCE_CHUNKS
    utterances = feed_all(seg, [SILENCE] * 20 + one + one)
    assert len(utterances) == 2


def make_wav(path):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(SPEECH * 10)


def test_transcribe_prefers_server(tmp_path, monkeypatch):
    wav = tmp_path / "u.wav"
    make_wav(wav)
    seen = {}

    def fake_post(url, **kwargs):
        seen["url"] = url
        seen["language"] = kwargs["data"].get("language")
        return httpx.Response(200, json={"text": " 你好 "}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    t = Transcriber(STTConfig(server_url="http://127.0.0.1:9881"))
    assert t.transcribe(wav) == "你好"
    assert seen["url"] == "http://127.0.0.1:9881/inference"
    assert seen["language"] == "zh"
    assert t._model is None  # 本地模型未被加载


def test_transcribe_falls_back_when_server_down(tmp_path, monkeypatch):
    wav = tmp_path / "u.wav"
    make_wav(wav)

    def fake_post(url, **kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx, "post", fake_post)
    t = Transcriber(STTConfig(server_url="http://127.0.0.1:9881"))
    monkeypatch.setattr(t, "_transcribe_local", lambda p: "本地结果")
    assert t.transcribe(wav) == "本地结果"
