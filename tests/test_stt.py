import struct

from voidmaker.voice.stt import BYTES_PER_CHUNK, CHUNK_MS, SpeechSegmenter

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
